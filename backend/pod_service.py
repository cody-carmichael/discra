import os
import re
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Dict, List, Optional
from uuid import uuid4

try:
    import boto3
except ImportError:  # pragma: no cover - boto3 available in Lambda
    boto3 = None

try:
    from backend.schemas import (
        PodArtifactType,
        PodMetadataRecord,
        PodPresignArtifactRequest,
    )
except ModuleNotFoundError:  # local run from backend/ directory
    from schemas import PodArtifactType, PodMetadataRecord, PodPresignArtifactRequest

MAX_UPLOAD_EXPIRY_SECONDS = 900
DEFAULT_UPLOAD_EXPIRY_SECONDS = 300
POD_KEY_PREFIX = "pod"

_ALLOWED_CONTENT_TYPES = {
    PodArtifactType.PHOTO: {"image/jpeg", "image/png", "image/webp"},
    PodArtifactType.SIGNATURE: {"image/png", "image/jpeg", "image/webp"},
}

_MAX_FILE_SIZE_BYTES = {
    PodArtifactType.PHOTO: 10 * 1024 * 1024,
    PodArtifactType.SIGNATURE: 2 * 1024 * 1024,
}

_SAFE_EXT_RE = re.compile(r"[^a-z0-9.]")


def _safe_extension(file_name: Optional[str]) -> str:
    if not file_name or "." not in file_name:
        return ""
    ext = file_name[file_name.rfind(".") :].lower()
    ext = _SAFE_EXT_RE.sub("", ext)
    if not ext.startswith(".") or len(ext) > 10:
        return ""
    return ext


def build_pod_key(org_id: str, order_id: str, driver_id: str, artifact: PodPresignArtifactRequest) -> str:
    ext = _safe_extension(artifact.file_name)
    return (
        f"{POD_KEY_PREFIX}/{org_id}/{order_id}/{driver_id}/"
        f"{artifact.artifact_type.value}/{uuid4()}{ext}"
    )


def pod_key_prefix(org_id: str, order_id: str, driver_id: str) -> str:
    return f"{POD_KEY_PREFIX}/{org_id}/{order_id}/{driver_id}/"


def get_upload_expiry_seconds() -> int:
    configured = os.environ.get("POD_UPLOAD_URL_EXPIRES_SECONDS")
    if not configured:
        return DEFAULT_UPLOAD_EXPIRY_SECONDS
    try:
        seconds = int(configured)
    except ValueError:
        return DEFAULT_UPLOAD_EXPIRY_SECONDS
    return max(60, min(seconds, MAX_UPLOAD_EXPIRY_SECONDS))


def validate_presign_artifact(artifact: PodPresignArtifactRequest):
    allowed_content_types = _ALLOWED_CONTENT_TYPES[artifact.artifact_type]
    max_size = _MAX_FILE_SIZE_BYTES[artifact.artifact_type]

    if artifact.content_type not in allowed_content_types:
        raise ValueError(
            f"Unsupported content_type '{artifact.content_type}' for artifact '{artifact.artifact_type.value}'"
        )
    if artifact.file_size_bytes > max_size:
        raise ValueError(
            f"file_size_bytes exceeds {max_size} for artifact '{artifact.artifact_type.value}'"
        )


def max_size_for_artifact(artifact_type: PodArtifactType) -> int:
    return _MAX_FILE_SIZE_BYTES[artifact_type]


class PodDataStore(ABC):
    @abstractmethod
    def create_presigned_post(
        self,
        key: str,
        content_type: str,
        expires_in: int,
        max_size_bytes: int,
    ) -> Dict:
        raise NotImplementedError

    @abstractmethod
    def put_metadata(self, metadata: PodMetadataRecord) -> PodMetadataRecord:
        raise NotImplementedError


class InMemoryPodDataStore(PodDataStore):
    def __init__(self):
        self.items: Dict[str, PodMetadataRecord] = {}

    def create_presigned_post(
        self,
        key: str,
        content_type: str,
        expires_in: int,
        max_size_bytes: int,
    ) -> Dict:
        return {
            "url": "https://example.invalid/pod-upload",
            "fields": {
                "key": key,
                "Content-Type": content_type,
                "x-max-size-bytes": str(max_size_bytes),
            },
        }

    def put_metadata(self, metadata: PodMetadataRecord) -> PodMetadataRecord:
        self.items[metadata.pod_id] = metadata
        return metadata


class DynamoS3PodDataStore(PodDataStore):
    def __init__(self, bucket_name: str, table_name: str):
        if boto3 is None:
            raise RuntimeError("boto3 not available")
        self.bucket_name = bucket_name
        self.s3 = boto3.client("s3")
        self.table = boto3.resource("dynamodb").Table(table_name)

    def create_presigned_post(
        self,
        key: str,
        content_type: str,
        expires_in: int,
        max_size_bytes: int,
    ) -> Dict:
        return self.s3.generate_presigned_post(
            Bucket=self.bucket_name,
            Key=key,
            Fields={"Content-Type": content_type},
            Conditions=[
                {"key": key},
                {"Content-Type": content_type},
                ["content-length-range", 1, max_size_bytes],
            ],
            ExpiresIn=expires_in,
        )

    def put_metadata(self, metadata: PodMetadataRecord) -> PodMetadataRecord:
        self.table.put_item(Item=metadata.model_dump(mode="json"))
        return metadata


_IN_MEMORY_POD_STORE = InMemoryPodDataStore()


def get_pod_data_store() -> PodDataStore:
    force_memory = os.environ.get("USE_IN_MEMORY_POD_STORE", "").strip().lower() in {"1", "true", "yes"}
    if force_memory:
        return _IN_MEMORY_POD_STORE

    bucket_name = os.environ.get("POD_BUCKET_NAME")
    table_name = os.environ.get("POD_ARTIFACTS_TABLE")
    if not bucket_name or not table_name:
        return _IN_MEMORY_POD_STORE

    try:
        return DynamoS3PodDataStore(bucket_name=bucket_name, table_name=table_name)
    except Exception:
        # Keep local development/test paths unblocked if AWS config is unavailable.
        return _IN_MEMORY_POD_STORE


def new_pod_metadata(
    org_id: str,
    order_id: str,
    driver_id: str,
    photo_keys: List[str],
    signature_keys: List[str],
    notes: Optional[str],
    captured_at: Optional[datetime],
    location,
) -> PodMetadataRecord:
    timestamp = datetime.now(timezone.utc)
    return PodMetadataRecord(
        org_id=org_id,
        pod_id=str(uuid4()),
        order_id=order_id,
        driver_id=driver_id,
        created_at=timestamp,
        captured_at=captured_at or timestamp,
        photo_keys=photo_keys,
        signature_keys=signature_keys,
        notes=notes,
        location=location,
    )


def reset_in_memory_pod_store():
    _IN_MEMORY_POD_STORE.items.clear()

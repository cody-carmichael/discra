import os
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

try:
    import boto3
    from boto3.dynamodb.conditions import Key
except ImportError:  # pragma: no cover - boto3 is available in Lambda runtime
    boto3 = None
    Key = None

try:
    from backend.schemas import OrganizationRecord, UserRecord
except ModuleNotFoundError:  # local run from backend/ directory
    from schemas import OrganizationRecord, UserRecord


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class IdentityRepository(ABC):
    @abstractmethod
    def get_org(self, org_id: str) -> Optional[OrganizationRecord]:
        raise NotImplementedError

    @abstractmethod
    def upsert_org(self, org: OrganizationRecord) -> OrganizationRecord:
        raise NotImplementedError

    @abstractmethod
    def get_user(self, org_id: str, user_id: str) -> Optional[UserRecord]:
        raise NotImplementedError

    @abstractmethod
    def upsert_user(self, user: UserRecord) -> UserRecord:
        raise NotImplementedError

    @abstractmethod
    def list_users(self, org_id: str) -> List[UserRecord]:
        raise NotImplementedError


class InMemoryIdentityRepository(IdentityRepository):
    def __init__(self):
        self._orgs: Dict[str, OrganizationRecord] = {}
        self._users: Dict[Tuple[str, str], UserRecord] = {}

    def get_org(self, org_id: str) -> Optional[OrganizationRecord]:
        return self._orgs.get(org_id)

    def upsert_org(self, org: OrganizationRecord) -> OrganizationRecord:
        self._orgs[org.org_id] = org
        return org

    def get_user(self, org_id: str, user_id: str) -> Optional[UserRecord]:
        return self._users.get((org_id, user_id))

    def upsert_user(self, user: UserRecord) -> UserRecord:
        self._users[(user.org_id, user.user_id)] = user
        return user

    def list_users(self, org_id: str) -> List[UserRecord]:
        return [user for (item_org_id, _), user in self._users.items() if item_org_id == org_id]


class DynamoIdentityRepository(IdentityRepository):
    def __init__(self, users_table_name: str, orgs_table_name: str):
        if boto3 is None:
            raise RuntimeError("boto3 not available")
        dynamodb = boto3.resource("dynamodb")
        self._users_table = dynamodb.Table(users_table_name)
        self._orgs_table = dynamodb.Table(orgs_table_name)

    def get_org(self, org_id: str) -> Optional[OrganizationRecord]:
        item = self._orgs_table.get_item(Key={"org_id": org_id}).get("Item")
        if not item:
            return None
        return OrganizationRecord.model_validate(item)

    def upsert_org(self, org: OrganizationRecord) -> OrganizationRecord:
        self._orgs_table.put_item(Item=org.model_dump(mode="json"))
        return org

    def get_user(self, org_id: str, user_id: str) -> Optional[UserRecord]:
        item = self._users_table.get_item(Key={"org_id": org_id, "user_id": user_id}).get("Item")
        if not item:
            return None
        return UserRecord.model_validate(item)

    def upsert_user(self, user: UserRecord) -> UserRecord:
        self._users_table.put_item(Item=user.model_dump(mode="json"))
        return user

    def list_users(self, org_id: str) -> List[UserRecord]:
        response = self._users_table.query(KeyConditionExpression=Key("org_id").eq(org_id))
        items = list(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            response = self._users_table.query(
                KeyConditionExpression=Key("org_id").eq(org_id),
                ExclusiveStartKey=response["LastEvaluatedKey"],
            )
            items.extend(response.get("Items", []))
        return [UserRecord.model_validate(item) for item in items]


_IN_MEMORY_REPO = InMemoryIdentityRepository()


def get_identity_repository() -> IdentityRepository:
    force_memory = os.environ.get("USE_IN_MEMORY_IDENTITY_STORE", "").strip().lower() in {"1", "true", "yes"}
    if force_memory:
        return _IN_MEMORY_REPO

    users_table = os.environ.get("USERS_TABLE")
    orgs_table = os.environ.get("ORGANIZATIONS_TABLE")
    if users_table and orgs_table and boto3 is not None:
        try:
            return DynamoIdentityRepository(users_table, orgs_table)
        except Exception:
            # Keep local development unblocked if Dynamo credentials/tables are unavailable.
            return _IN_MEMORY_REPO
    return _IN_MEMORY_REPO

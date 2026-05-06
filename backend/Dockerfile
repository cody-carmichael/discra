ARG BASE_IMAGE=public.ecr.aws/lambda/python:3.12
FROM ${BASE_IMAGE}

COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

COPY . ${LAMBDA_TASK_ROOT}/

CMD ["app.handler"]

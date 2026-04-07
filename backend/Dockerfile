ARG BASE_IMAGE=public.ecr.aws/lambda/python:3.12
FROM ${BASE_IMAGE}

COPY . ${LAMBDA_TASK_ROOT}/

CMD ["app.handler"]

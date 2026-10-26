#!/usr/bin/env bash
# Build the bridge web app image from the current checkout, push it to ECR and
# roll the ECS service onto it.
# Usage: infra/deploy-app.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tf_dir="$root/infra/terraform"
region=us-east-2
repo="$(terraform -chdir="$tf_dir" output -raw ecr_repository_url)"
cluster="$(terraform -chdir="$tf_dir" output -raw cluster_name)"
service="$(terraform -chdir="$tf_dir" output -raw service_name)"
tag="$(git -C "$root" rev-parse --short HEAD)"
[[ -z "$(git -C "$root" status --porcelain -- . ':!infra')" ]] || tag="$tag-dirty"

docker build -f "$root/infra/app.Dockerfile" --platform linux/arm64 -t "${repo}:${tag}" -t "${repo}:latest" "$root"
aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "${repo%%/*}"
docker push "${repo}:${tag}"
docker push "${repo}:latest"

aws ecs update-service --region "$region" --cluster "$cluster" --service "$service" \
  --force-new-deployment --query 'service.deployments[0].id' --output text
echo "Waiting for ${service} to stabilize on ${tag}..."
aws ecs wait services-stable --region "$region" --cluster "$cluster" --services "$service"
echo "Deployed ${tag} to $(terraform -chdir="$tf_dir" output -raw url)"

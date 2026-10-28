variable "aws_region" {
  description = "AWS region for every resource in this stack."
  type        = string
  default     = "us-east-2"
}

variable "account_id" {
  description = "Alpha Compute AWS account. The provider refuses to run against any other."
  type        = string
  default     = "098767424196"
}

variable "project_name" {
  description = "Value of the Project tag and prefix for resource names."
  type        = string
  default     = "midnight-ton-bridge"
}

variable "environment" {
  description = "Value of the Environment tag."
  type        = string
  default     = "prod"
}

variable "owner" {
  description = "Value of the Owner tag: the person or team responsible."
  type        = string
  default     = "dax"
}

variable "vpc_cidr" {
  description = "CIDR of the project VPC. Per-project VPCs in this account take 10.201.0.0/16 upward."
  type        = string
  default     = "10.201.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones for public subnets. The ALB needs at least two."
  type        = number
  default     = 2
}

variable "domain_name" {
  description = "Public hostname for the bridge web app."
  type        = string
  default     = "bridge.alphacompute.dev"
}

variable "container_port" {
  description = "Port app/server.ts listens on inside the container."
  type        = number
  default     = 3080
}

variable "ecs_cpu" {
  description = "Fargate CPU units."
  type        = number
  default     = 512
}

variable "ecs_memory" {
  description = "Fargate memory (MB)."
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Number of app tasks."
  type        = number
  default     = 1
}

variable "ton_rpc_url" {
  description = "TON testnet v4 RPC the app reads from."
  type        = string
  default     = "https://testnet-v4.tonhubapi.com"
}

variable "log_retention_days" {
  description = "CloudWatch log retention (days)."
  type        = number
  default     = 30
}

variable "ecr_image_count" {
  description = "Number of ECR images to keep."
  type        = number
  default     = 10
}

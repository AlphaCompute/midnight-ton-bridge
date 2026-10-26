output "url" {
  value = "https://${var.domain_name}"
}

output "alb_dns_name" {
  description = "Target for the Cloudflare CNAME (DNS only)."
  value       = aws_lb.app.dns_name
}

output "acm_validation_records" {
  description = "DNS-only CNAME records to create in Cloudflare for certificate validation."
  value = [for dvo in aws_acm_certificate.app.domain_validation_options : {
    name  = trimsuffix(dvo.resource_record_name, ".")
    type  = dvo.resource_record_type
    value = trimsuffix(dvo.resource_record_value, ".")
  }]
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "cluster_name" {
  value = aws_ecs_cluster.app.name
}

output "service_name" {
  value = aws_ecs_service.app.name
}

output "midnight_indexer_secret_arn" {
  value = aws_secretsmanager_secret.midnight_indexer.arn
}

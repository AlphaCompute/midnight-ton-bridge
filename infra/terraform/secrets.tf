# Midnight indexer endpoints. Midnight retired its hosted preprod indexer on
# 2026-10-09; preprod is now served by Blockfrost, whose URLs carry the project
# ID. Both keys start empty, which the app reports as "indexer not configured".
# Fill them with put-secret-value (see infra/README.md); Terraform ignores the
# value after creation.
resource "aws_secretsmanager_secret" "midnight_indexer" {
  name        = "${var.project_name}/midnight-indexer"
  description = "Blockfrost Midnight preprod indexer URLs for the bridge web app"
}

resource "aws_secretsmanager_secret_version" "midnight_indexer" {
  secret_id = aws_secretsmanager_secret.midnight_indexer.id
  secret_string = jsonencode({
    MIDNIGHT_INDEXER_URL = ""
    MIDNIGHT_INDEXER_WS  = ""
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

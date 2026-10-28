terraform {
  backend "s3" {
    bucket       = "alpha-compute-tfstate-098767424196"
    key          = "midnight-ton-bridge/terraform.tfstate"
    region       = "us-east-2"
    encrypt      = true
    use_lockfile = true
  }
}

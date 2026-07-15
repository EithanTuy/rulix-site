terraform {
  # Production uses a partial S3 backend configuration so CI and operators can
  # supply credentials/profile details without committing machine-local values.
  # See README.md for the exact bucket, key, KMS, and native lockfile settings.
  backend "s3" {}
}

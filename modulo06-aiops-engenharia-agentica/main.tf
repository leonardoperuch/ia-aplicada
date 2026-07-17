provider "aws" {
  region = "us-east-1"
}

resource "aws_s3_bucket" "nexus-apollo-data" {
  bucket = "nexus-apollo-data"
  acl    = "private"
  versioning {
    enabled = true
  }
  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default {
        sse_algorithm = "AES256"
      }
    }
  }
  tags = {
    Name        = "nexus-apollo-data"
    Environment = "prod"
  }
}

resource "aws_s3_bucket_public_access_block" "nexus-apollo-data" {
  bucket = aws_s3_bucket.nexus-apollo-data.id
  block_public_acls   = true
  block_public_policy = true
  ignore_public_acls  = true
  restrict_public_buckets = true
}
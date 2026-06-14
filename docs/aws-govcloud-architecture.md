# AWS and GovCloud Architecture

## Deployment Shape

Use single-tenant hosted deployments. Each facility receives isolated AWS accounts, S3 buckets, KMS keys, database, vector index, audit logs, and Bedrock resources. Keep IaC partition-aware from day one so commercial AWS uses `aws` and GovCloud uses `aws-us-gov` without code rewrites.

## Data Flow

1. Upload memo and supporting documents to S3 with versioning, KMS customer-managed keys, object tags, and hash capture.
2. Run malware/type checks and metadata extraction before AI processing.
3. Extract text through backend workers. Use Textract or equivalent OCR for scanned PDF/images and a document parser for DOCX/email/table attachments.
4. Store extracted claims, text offsets, source hashes, and reviewer edits in Postgres.
5. Keep the official regulatory corpus separate from customer uploads. Regulatory chunks require source URL, snapshot date, locator, checksum, and tags.
6. Retrieve official chunks with metadata filters and require citations in every AI finding.
7. Persist model ID, prompt template version, retrieved chunk IDs, outputs, reviewer decisions, and report bundles.

## AI Council

The production council should be orchestrated by application code rather than free-running model calls:

- Memo parser
- Product/spec extractor
- Jurisdiction gate
- ECCN candidate finder
- Evidence mapper
- Citation verifier
- Contradiction/risk reviewer
- Report writer

Use Claude Sonnet through Amazon Bedrock where available, with model IDs pinned in configuration and a provider abstraction for swaps. The local prototype simulates this council deterministically so tests can run offline.

## Security Baseline

- Private app tiers inside VPCs.
- VPC endpoints or PrivateLink for AWS service access where supported.
- Customer-managed KMS keys for S3, database, logs, OpenSearch/vector store, and evidence bundles.
- IAM Identity Center or tenant SSO with MFA.
- Least-privilege IAM and ABAC by tenant/project/classification.
- CloudTrail organization trails, Bedrock invocation/audit logging by policy, and app-level audit events.
- S3 Object Lock for immutable evidence bundles where retention requirements apply.

## GovCloud Migration Readiness

Commercial AWS can host development and authorized pilots, but real ITAR/CUI/export-controlled technical-data processing should be treated as GovCloud-bound unless customer compliance and counsel approve otherwise.

Migration requirements:

- Parameterize partition, region, ARN formats, endpoints, account IDs, STS behavior, and service availability.
- Avoid commercial-to-GovCloud trust assumptions.
- Verify current Bedrock model availability, cross-region inference policy, Textract availability, and vector-store options in the target GovCloud region.
- Recreate infrastructure with IaC, copy only approved corpus/customer data, and re-run security acceptance tests.

## Records and Review

Store immutable audit trails for uploads, extracted claims, source chunks, prompts, model outputs, reviewer edits, decisions, overrides, final reports, and signers. Export classification records as evidence bundles with corpus version and source checksums.


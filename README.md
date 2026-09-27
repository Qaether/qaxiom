# Qaxiom

Public source for [qaxiom.qaether.com](https://qaxiom.qaether.com/).

The site is served from the `site/` directory. Pushing to `main` runs the
deployment workflow: GitHub Actions assumes a dedicated AWS role using OIDC,
syncs `site/` to the private `qaxiom.qaether.com` S3 bucket, and invalidates
the CloudFront cache. AWS access keys are not stored in GitHub.

The initial page is a placeholder. Replace or extend `site/` with the site you
want to publish. Files removed from `site/` are also removed from the bucket
on the next deployment.

## Infrastructure

`infra/qaxiom-access-point-stack.json` creates an S3 access point in
`ap-northeast-2`. Its alias avoids the TLS limitation of dotted bucket names.
`infra/qaxiom-stack.json` defines the HTTPS certificate, private S3 access,
CloudFront distribution, Route 53 records, and the GitHub deployment role.
It is deployed as the `qaxiom-site` CloudFormation stack in `us-east-1`.
The access point stack is updated with the CloudFront distribution ID after
the site stack completes, restricting its read policy to that distribution.
The S3 bucket already exists in `ap-northeast-2` and is not part of the stack.

The workflow uses repository variables `AWS_DEPLOY_ROLE_ARN` and
`CLOUDFRONT_DISTRIBUTION_ID`, populated from the stack outputs.

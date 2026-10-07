# Production custom domain

Requested hostname: `tasks.abuk.in`, backed by the existing production distribution `E3ODX4A55HXUY5` / `d2e5t8yuyjw8m2.cloudfront.net` in AWS account `061525403372`.

The existing public Route 53 zone `Z07756052FLIKFJDVDRZW` for `abuk.in` is delegated correctly. No record existed at the requested hostname before this change. The `learnverse-tasks-certificate` stack in `us-east-1` owns a DNS-validated public ACM certificate for this hostname; the existing `learnverse-tasks-prod` stack in `ap-south-1` owns its CloudFront alias and A/AAAA alias records. Public non-exportable ACM certificates have [no certificate fee](https://aws.amazon.com/certificate-manager/pricing/). No domain registration or additional hosted zone is required.

Run `scripts/aws-domain.py` in authenticated CloudShell. Each action creates and reviews a CloudFormation change set, rejects resource removals/replacements and IAM changes, and preserves the existing origin secret and immutable backend ZIP:

1. `certificate`: create/validate the certificate through the existing hosted zone.
2. `dev`: apply the generalized template to dev with the domain disabled and verify the existing dev URL.
3. `edge`: attach the issued certificate and hostname to production, leaving DNS and canonical activation disabled; verify the existing CloudFront URL.
4. `dns`: publish A and AAAA aliases, then check normal DNS and HTTPS on the hostname.
5. `activate`: use the custom hostname as the application's exact expected origin and redirect old CloudFront HTML navigation to the new hostname. Verify assets, routing, health, anonymous rejection, no WAF and redirects. Then run the live API/MCP checks against the new hostname.

The redirect preserves deep links and repeated query values. Asset/API requests retain their original paths; missing JavaScript never becomes SPA HTML. Browser sessions are scoped to their hostname, so users sign in once at the new domain with their existing account.

`output/domain-rollback.json` saves the original DNS state and nonsecret stack parameters; `output/domain-previous-template.json` saves the previous template. To roll back publication while preserving resources, first set `ActivateCustomDomain=false` using a reviewed change set. This restores the CloudFront hostname as the allowed browser origin and disables redirects. Leave DNS/certificate attached until any clients have migrated back. Removing A/AAAA records is a distinct DNS action; restore only the saved records at `tasks.abuk.in` and never alter other names in the shared zone. Retain the certificate for recovery. Full template rollback would remove newly managed records and requires explicit resource-removal review.

CloudFront remains pay-as-you-go, PriceClass 100, and has no WAF. Source CloudFormation validation has one known optional-certificate W1030 false positive: the certificate ARN parameter permits an empty default for dev, while `HasCustomDomain` and the `RequireCertificate` assertion prevent an empty ARN in the certificate branch. Validation suppresses only W1030 and reports all other diagnostics.

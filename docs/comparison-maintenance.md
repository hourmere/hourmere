# Maintaining marketing comparisons

Comparison pages live under `apps/site/src/content/docs/docs`. Each comparison page must
have one quoted ISO calendar date in frontmatter, `lastVerified: 'YYYY-MM-DD'`.
`content.config.ts` validates the date and `DocsPageTitle.astro` displays it to readers.
Do not repeat verification dates in prose or infer them from the build or Git timestamp.

Before advancing that date, re-read every linked primary source: the vendor's own product
documentation, terms, trademark notices and official source repository. Recheck the exact
edition, deployment model, authentication and feature limits. Verify legal owner names
from those sources; do not infer trademark ownership from a domain or a software license.
For Hourmere claims, inspect the current implementation and its repository documentation;
separate implemented behavior from live-provider acceptance. Avoid repository-visibility
claims, whose accuracy changes independently of product behavior.

Keep a supporting link next to each factual claim. Correct or remove any claim that the
primary source no longer supports, and record unavailable/conflicting sources and removed
claims in the PR for the owner. Check that attribution and the neutral non-affiliation
notice still cover the compared products. Advance `lastVerified` only after this review,
then build `@hourmere/site` and check the comparison's generated text, links and date.
Wording changes need owner review before merge or deployment.

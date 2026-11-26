# Recorded edition and local findings {#sec:snapshot}

The six receipt-listed files match their committed byte lengths and
digests. The projection, manifest, and verification report agree on
245 article pages and 2,206 sections. The projection has no duplicate
article or section identifiers. The historical report records that the
local verification, current table-of-contents comparison, and sampled
source comparison passed at its observation time. All five selected
sample checks passed in that recorded comparison.

The median article has six sections. Counts range from zero to 112,
and four section records have empty text after whitespace trimming.
An empty text field remains part of the indexed edition's structural
denominator. It does not independently identify why the source field
is empty. [@fig:section-counts] shows that article size varies widely,
so article-level and section-level counts answer different questions.

![Histogram of sections per article in the reviewed edition, with a median of six and a long right tail.](../../output/figures/sections-per-article.png){#fig:section-counts width=95%}

The build from the checked-in seed passed the native Pages artifact
validator without a municipal source refresh. Its acceptance establishes
that the local export was structurally valid for the installed runtime.

# Edition custody and local checks {#sec:methods}

The public input receipt identifies the edition and lists the byte
length and SHA-256 digest of each bound file. These files include the
code projection, table of contents, manifest, verification report, and
derived reading and coverage records. The verification report binds its
manifest and table of contents to their digests and records an independent
article-set binding. The article-set binding concerns retained source
material. The published projection is enough to check public bytes but
does not provide the raw custody required to recompute that binding.

The local audit recomputed each receipt-listed byte length and digest
using SHA-256 [@nist1804]. It counted unique article identifiers and
section identifiers in the projection and compared totals with both the
manifest and report. It summarized sections per article without
recovering missing text or labeling records from their content. It also
read the historical source sample results as recorded, without rerunning
the sample.

The installed consumer gate exercised type checking and identity
binding. With the checked-in seed, the native static exporter built the
site and its artifact validator accepted the output in the local
checkout. Those steps preserve boundaries between the shared
implementation, consumer configuration, and observed fact inputs.

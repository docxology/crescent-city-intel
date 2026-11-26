# Crescent City deployment manuscript

The numbered sections describe the deployment and the local audit of its
[accepted municipal edition](../edition.md). The [edition summary](evidence.json)
records the counts shown in the paper. It was computed from the
[public projection](../../pages-data/crescent-city-code.json), the
[verification report](../../pages-data/verification-report.json), and the
[publication input receipt](../../pages-data/publication-input.json).
The [histogram](figures/sections-per-article.png) groups the lengths of
`articles[].sections` by five-section bins. The vertical line marks
the median. The [figure registry](figure_registry.json) records the
caption, asset path, and data origin.

The generic methods and original reference manuscript remain in
[region-intel](https://github.com/docxology/region-intel/tree/51b18faeec1454e80a533795c6e3859eaeb5fc9b).
The installed `manuscript:check` command targets that shared reference
contract. This report uses Template and its own regional sources. The
[consumer acceptance checks](../operations.md#local-checks-without-new-acquisition)
verify the public seed and local export separately from the paper.

## Render and validate

Prepare uv, Pandoc with a compatible pandoc-crossref, and XeLaTeX using the
[pinned Template run guide](https://github.com/docxology/template/blob/87704feae0a4490ef7dad9c931d268e8c30273c2/docs/RUN_GUIDE.md).
The commands assume the consumer checkout is a sibling of the Template
checkout. The [Template project guide](https://github.com/docxology/template/blob/87704feae0a4490ef7dad9c931d268e8c30273c2/projects/README.md)
describes working-project registration.

```sh
git clone https://github.com/docxology/template.git template
cd template
git checkout --detach 87704feae0a4490ef7dad9c931d268e8c30273c2
uv sync --locked --no-dev --python 3.14
mkdir -p projects/working
git -C ../crescent-city-intel worktree add --detach \
  "$PWD/projects/working/crescent-city-intel" HEAD
project=projects/working/crescent-city-intel
mkdir -p "$project/output/figures" "$project/output/data"
cp "$project/docs/manuscript/figures/sections-per-article.png" "$project/output/figures/"
cp "$project/docs/manuscript/figure_registry.json" "$project/output/figures/"
cp "$project/docs/manuscript/evidence.json" "$project/output/data/edition-evidence.json"
uv run --no-sync python scripts/pipeline/stage_03_render.py --project working/crescent-city-intel
uv run --no-sync python scripts/pipeline/stage_04_validate.py --project working/crescent-city-intel
```

The registered checkout receives `output/pdf/crescent-city-intel_combined.pdf`,
`output/web/index.html`, and validation and provenance reports in
`output/reports/`. The commands use the saved figure and recorded municipal
edition. Rendering requires neither live regional data nor a model service.

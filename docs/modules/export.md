# Export Module

## `src/export.ts` — Multi-Format Exporter

Converts one manifest-bound scraped article set into four usable formats.
The CLI's data loader checks source custody before format generation. Imports
expose format builders and do not trigger filesystem writes.

### Output Formats

| Format | File | Description |
|--------|------|-------------|
| **JSON** | `output/crescent-city-code.json` | All sections with full metadata in one consolidated file |
| **Markdown** | `output/markdown/` | Organized by Title/Chapter directories with cross-linked README indices |
| **Plain Text** | `output/crescent-city-code.txt` | Full text corpus, suitable for NLP/text processing |
| **CSV** | `output/section-index.csv` | Section index with GUIDs, numbers, titles, chapter info, history |

Each consolidated JSON article preserves its saved HTML hash (`sha256`) and
adds `exportedArticleSha256`, covering its identity and ordered parsed section
text/history. These hashes have different meanings: the raw HTML hash alone
does not bind a changed parsed export. Public bundle selection recomputes the
canonical article-set hash against the verification receipt before publishing.
`exportedAt` records export time, separately from source verification time.

Format files use atomic replacements individually. Coherent public tree
selection, staged validation, promotion recovery, and retained prior editions
are handled by `publication_bundle.ts` and the [Pages exporter](pages.md).

### Markdown Organization

```
output/markdown/
  Title_01_General_Provisions/
    README.md          # Title index with links to all sections
    1.04.md            # Chapter content
    1.08.md
    ...
  Title_02_Administration_Personnel/
    ...
  Other/               # Appendices and standalone articles
```

### CSV Schema

```
guid,number,title,chapter_guid,chapter_number,chapter_title,history
```

### Dependencies

Uses utility functions from `utils.ts`:

- `flattenToc` — traverse TOC tree for title grouping
- `htmlToText` — fallback text extraction from HTML
- `csvEscape` — safe CSV value formatting
- `sanitizeFilename` — filesystem-safe directory and file names

### Usage

```bash
bun run export    # Requires scraper output to exist
```

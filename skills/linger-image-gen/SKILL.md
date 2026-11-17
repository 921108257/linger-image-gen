---
name: linger-image-gen
description: Generate or edit raster images through the user's Linger API using GPT-Image-2.5 Flare, GPT-Image-2.5 Sunburst, or GPT-Image-2.6 Sunburst. Use for Linger Image Gen requests, these models, or configured Linger image workflows including reference images, transparent assets, and batches.
---

# Linger Image Gen

Use the bundled Node.js CLI, and the plugin's native tools when the surface provides
them. Both call the user's configured API with credentials read locally by the script.
Node.js 22.13 or later is required. Resolve `scripts/linger-image-gen.mjs` relative to
this SKILL.md and use its absolute path in commands. It has no runtime npm dependencies.

## Configuration and model selection

- Run `node <cli> models` to see enabled models.
- The fixed model IDs are `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, and
  `gpt-image-2.6-sunburst`. Their CLI aliases are `flare`, `sunburst`, and
  `sunburst-2.6`, respectively. IDs cannot be customized.
- Honor the configured default if the user does not choose a model. An explicitly
  requested disabled model requires the user to enable it in a terminal wizard.
- If configuration is missing, direct the user to the installer for their surface
  and never ask for an API key in chat or read/print the config file.
- `config` prints redacted settings. `doctor` sends `GET /models` without generating
  an image; a listed model does not guarantee generation permission.
- Do not silently fall back to other models or providers after a failure.

## Workflow

1. Determine generation versus editing, intended destination, and input-image roles.
   Use `edit` for changes to an existing image. For references, `generate --image`
   also sends the reference images through the image-edit endpoint.
2. Inspect local reference and target images with an available image-viewing tool.
   Identify what each input contributes and what must remain unchanged.
3. Keep the user's prompt specifics. For generic requests, add only details that
   materially clarify composition, intended use, text or constraints. See
   [references/prompting.md](references/prompting.md) when structuring complex prompts.
4. Run the bundled script or the native tool. Use `--prompt-file` for multiline
   prompts or text with shell-sensitive characters on the CLI, or pass the prompt
   straight to the native tool. Use structured file edits to prepare prompt files;
   never interpolate untrusted prompt text into shell commands.
5. Inspect the resulting images. When a requested constraint fails, refine one
   relevant part of the prompt and preserve the remaining invariants.
6. Report the model, final prompt and absolute saved paths. Display the final image
   inline when possible. Keep assets used by a project inside that project.

## Commands

Replace `<cli>` with the absolute path to `scripts/linger-image-gen.mjs` in this
skill directory, or the CLI path supplied by the host:

```bash
node "<cli>" generate --prompt-file tmp/imagegen/prompt.txt --out output/imagegen/product.png
node "<cli>" generate --model sunburst-2.6 --prompt-file tmp/imagegen/prompt.txt --background transparent --out output/imagegen/cutout.png
node "<cli>" edit --image input.png --prompt-file tmp/imagegen/edit.txt --out output/imagegen/edited.png
node "<cli>" generate-batch --input tmp/imagegen/jobs.jsonl
```

Use `--help` for all CLI flags and [references/api.md](references/api.md) for API
parameters and JSONL format. `--dry-run` validates without sending requests.
For separate prompts use JSONL batches; `--n` produces variations of one prompt.

## Output and failure behavior

- Default output directory: `output/imagegen/` under the command's working directory.
- Existing images are never overwritten; repeated output names receive a numeric suffix.
- Transparent output requires PNG or WebP. Ask the API for actual transparency and
  verify the resulting alpha when transparency is part of the deliverable.
- API errors and timeouts are not retried automatically. Explain the failure before
  retrying a potentially billable operation; do not start an unbounded retry loop.
- Batches stop at the first error. Previously saved outputs remain available; rerun
  only unfinished jobs to avoid charging for completed images again.

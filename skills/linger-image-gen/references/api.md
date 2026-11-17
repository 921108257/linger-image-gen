# Linger API contract

The service must expose OpenAI-compatible image endpoints beneath BASE_API:

- `POST /images/generations`: JSON request.
- `POST /images/edits`: multipart request with repeatable `image[]` and optional `mask`.
- `GET /models`: optional connectivity/model-list check.

A bare origin gets `/v1` appended; an explicit path such as `/api/v1` is preserved.
Authorization is `Bearer API_KEY`. Credentials are never sent to image download hosts.
HTTP redirects are rejected, so enter the final API base URL.

Only `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, and `gpt-image-2.6-sunburst`
are accepted, and only when enabled in the user's config. The aliases are `flare`,
`sunburst`, and `sunburst-2.6`, respectively. The CLI does not accept custom model IDs.

Optional controls: `size`, `quality`, `background`, `output_format`, `n` (1–10).
The default format is PNG. Other defaults are left to the provider. Quality options
are `auto`, `low`, `medium`, `high`, `xhigh`, `max`; provider support may vary.
Transparency requires PNG or WebP. Size may be `auto` or `WIDTHxHEIGHT`, with both
edges divisible by 16, aspect ratio from 1:3 to 3:1, max edge 3840, and pixel count
from 655360 to 8294400. Large resolutions may be experimental at the provider.

Inputs: up to 16 PNG/JPEG/WebP files, at most 50 MB each; masks must be PNG.
Use a mask with an alpha channel and the same dimensions as the first input image.
The API interprets transparent mask pixels as the editable region. The CLI validates
file type but does not validate mask dimensions or alpha content locally.

Responses must contain `data[]` with `b64_json` or, for compatible gateways, `url`.
Downloaded/decoded images are checked for PNG/JPEG/WebP signatures and saved with
matching extensions. No `response_format` or `input_fidelity` is sent.

## Batch JSONL

One JSON object per line; paths resolve relative to the working directory.
All jobs are validated before the first request, then run sequentially.

```jsonl
{"prompt":"Studio product photograph of a white ceramic cup","model":"flare","out":"output/imagegen/cup.png"}
{"prompt":"Studio product photograph of a white ceramic cup","model":"sunburst-2.6","out":"output/imagegen/cup-2.6.png"}
{"prompt":"Change only the background to white; preserve the product","model":"sunburst","image":["input/product.png"],"out":"output/imagegen/edited.png"}
```

Allowed fields: `prompt`, `model`, `n`, `size`, `quality`, `output_format`,
`background`, `image` (array), `mask`, `out`. Each job uses the configured default
model when `model` is omitted. Disabled models are rejected before any request.

## Configuration

The wizard writes `~/.config/linger-image-gen/config.json` with file mode `0600`
on POSIX systems. The API key is stored as local plaintext, not in the plugin or
npm package. On Windows, restrict file access with the current user's permissions.
`LINGER_IMAGE_GEN_CONFIG` selects another config path. `BASE_API` and `API_KEY`
environment variables override file values. Without a config file, these two
variables enable all fixed models and default to Flare. Existing config files keep
their enabled models and default; use `configure` to enable a newly added model.

## Protocol reference

- https://developers.openai.com/api/reference/resources/images/methods/generate
- https://developers.openai.com/codex/plugins/

The configured gateway may differ from the official API; live access must be
verified against that gateway rather than inferred from its model list.

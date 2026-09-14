# Prompt shaping

Normalize specific prompts rather than adding new creative requirements. For a
generic request, clarify its intended use, framing, lighting, and practical constraints.
Do not invent brands, slogans, characters, or story beats.

```text
Use case: product-mockup / photorealistic-natural / illustration-story / precise-object-edit
Asset type: intended use
Primary request: user's request
Input images: each image's role, when present
Scene/backdrop: setting
Subject: main subject
Style/medium: requested visual treatment
Composition/framing: requested layout
Text (verbatim): exact text, when present
Constraints: required invariants and exclusions
```

Include only relevant fields. Quote text exactly. For edits, explicitly state
"change only X; keep Y unchanged", naming identity, geometry, pose, materials,
branding, or background as applicable. For multiple images, reference their input
order. Describe transparency in the prompt as well as setting `--background transparent`.

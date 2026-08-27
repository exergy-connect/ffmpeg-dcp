# LinkedIn post metadata

Drop a JSON metadata file here to publish a video post to the configured
LinkedIn feed (person or organization). Pushing `*.json` under this tree
triggers the
[Post to LinkedIn](../../../.github/workflows/post-to-linkedin.yml) workflow.

## Metadata schema

Each `.json` file is one post request:

```json
{
  "text": "Caption within LinkedIn’s 1200-character organic limit…",
  "video": "xframe/uploads/test_video.mp4"
}
```

| Field | Required | Rules |
| --- | --- | --- |
| `text` | yes | Non-empty; ≤ 1200 characters |
| `video` | yes | Repo-relative path to an `.mp4` already in the tree (no `..`, no absolute paths) |

See [`example.post.json.example`](example.post.json.example) (`.example` suffix so it
does not match the workflow trigger).

## Prerequisites

1. The transcoded MP4 is already committed under the repo (for example by the
   DCP worker under `xframe/uploads/`).
2. Repository secrets / variables are set:

| Name | Type | Purpose |
| --- | --- | --- |
| `LINKEDIN_ACCESS_TOKEN` | secret | OAuth token with `w_member_social` and/or `w_organization_social` |
| `LINKEDIN_AUTHOR_URN` | secret or variable | `urn:li:person:{id}` **or** `urn:li:organization:{id}` |
| `LINKEDIN_API_VERSION` | variable (optional) | YYYYMM; defaults to `202608` if unset (must be an active LinkedIn Marketing API version) |

- **Person feed:** token needs `w_member_social`; author is `urn:li:person:…`.
- **Organization Page:** token needs `w_organization_social` and Page admin;
  author is `urn:li:organization:…`.

The workflow does not branch on author type — LinkedIn validates scopes.

## Behavior

- Only JSON files **changed in the push** are processed (re-pushing the same
  file re-posts).
- Use **Actions → Post to LinkedIn → Run workflow** for intentional re-posts
  (`metadata_path` optional; empty processes all JSON under this tree).
- The workflow uploads the local MP4 via LinkedIn’s Videos API, waits until the
  asset is `AVAILABLE`, then creates the post with `text` as commentary.

## Future web client contract

Not wired yet. Intended flow:

1. DCP worker / prior step places the MP4 under e.g. `xframe/uploads/…`.
2. Client builds the caption and commits JSON here with `text` + `video`.
3. This workflow publishes natively to LinkedIn.

## Local dry-run

From the repository root (no LinkedIn credentials required):

```bash
node xframe/scripts/post-to-linkedin.mjs --dry-run xframe/posts/linkedin/example.post.json.example
```

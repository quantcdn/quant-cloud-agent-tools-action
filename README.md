# Quant Agent Tools Action

A GitHub Action for registering and updating custom tools on the Quant platform for use by AI agents. Reads tool definitions from a directory structure and registers each tool via the API — the platform deploys the tool's edge function itself and registers the tool against it.

## Features

- **Tool Registration**: Creates new tools or updates existing ones based on `tool.json`
- **Edge Function Deployment**: Sends each tool's `fn.js` source to the platform, which deploys it and computes the function URL — no separate edge-function deploy step needed
- **Upsert Semantics**: The API upserts by tool name — existing tools are updated in place and their edge function code redeployed under the same uuid
- **Full Schema Support**: Supports input/output schemas, response modes, async execution, and timeouts

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `quant_api_key` | Yes | Quant API key |
| `quant_organization` | Yes | Quant organisation name |
| `tools_dir` | Yes | Directory containing tool definitions (default: `tools/`) |
| `base_url` | No | Quant API base URL |
| `preview_domain` | No | **Deprecated** — ignored. The platform computes edge function URLs itself |
| `quant_project` | No | **Deprecated** — ignored. The platform computes edge function URLs itself |

## Outputs

| Output | Description |
|--------|-------------|
| `deployed_tools` | JSON array of deployed tool names |

## Directory Structure

Each tool lives in its own subdirectory containing both its definition and its edge function source:

```
tools/
  my-tool/
    tool.json              # Required — tool definition
    fn.js                  # Required — edge function source, deployed by the platform
```

The action fails with a clear error if `fn.js` is missing. The platform deploys `fn.js` as the tool's edge function and registers the tool against the deployed function's URL — you do not (and cannot) supply the URL yourself.

## `tool.json`

Tool definition matching the Quant AI API:

```json
{
  "toolName": "quantassure_compliance_assessment",
  "description": "Submit a structured compliance assessment",
  "category": "assessment",
  "responseMode": "direct",
  "timeout": 30,
  "inputSchema": {
    "type": "object",
    "properties": {
      "control_assessments": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "control_id": { "type": "string" },
            "compliance_status": {
              "type": "string",
              "enum": ["compliant", "needs_review", "non_compliant"]
            }
          }
        }
      }
    },
    "required": ["control_assessments"]
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `toolName` | Yes | Unique tool identifier |
| `description` | Yes | Description of what the tool does |
| `inputSchema` | Yes | JSON Schema defining the tool's input parameters |
| `category` | No | Tool category for organisation |
| `responseMode` | No | `direct` or `llm` |
| `isAsync` | No | Whether the tool runs asynchronously |
| `timeout` | No | Timeout in **seconds** (5–300). Values above 300 are assumed to be milliseconds from older configs and converted with a warning |
| `outputSchema` | No | JSON Schema for tool output |
| `outputSchemaDescription` | No | Description of the output schema |
| `uuid` | No | **Deprecated** — informational only. The platform manages edge function uuids (see migration notes) |
| `edgeFunctionUrl` | No | **Deprecated** — ignored. The platform computes the URL from the deployed function |
| `executionMode` | No | **Deprecated** — ignored. All tools are deployed as edge functions |

## Usage

### Basic Usage

```yaml
- name: Register Tools
  uses: quantcdn/quant-cloud-agent-tools-action@v1
  with:
    quant_api_key: ${{ secrets.QUANT_API_KEY }}
    quant_organization: ${{ secrets.QUANT_ORGANIZATION }}
    tools_dir: tools/
```

### Complete Pipeline Example

```yaml
name: Agent Validation Pipeline
on:
  push:
    branches: [main]
    paths: ['agents/**', 'tools/**']

jobs:
  deploy-and-validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Register Tools
        uses: quantcdn/quant-cloud-agent-tools-action@v1
        with:
          quant_api_key: ${{ secrets.QUANT_API_KEY }}
          quant_organization: ${{ secrets.QUANT_ORGANIZATION }}
          tools_dir: tools/

      - name: Deploy Agents
        uses: quantcdn/quant-cloud-agent-deploy-action@v1
        with:
          quant_api_key: ${{ secrets.QUANT_API_KEY }}
          quant_organization: ${{ secrets.QUANT_ORGANIZATION }}
          agents_dir: agents/
```

## Migrating from Earlier Versions

Earlier versions of this action built an edge function URL from a `uuid` in `tool.json` plus the `preview_domain`/`quant_project` inputs, and assumed the edge function was deployed by a separate workflow step. The platform API now owns both concerns:

- **Add `fn.js`** to each tool directory — the edge function source the platform should deploy.
- **Remove separate edge-function deploy steps** for these tools from your workflow — they are redundant; the registration call deploys the code.
- **`preview_domain` and `quant_project` inputs** can be removed from your workflow — they are accepted but ignored.
- **`uuid` in `tool.json`** is now informational only, and the action warns when it is present. The platform reuses the existing tool's uuid on update, so a uuid aligned with your `functions.json` stays stable **only if** the tool is already registered with that uuid in its edge function URL. If the tool has never been registered (or registration previously failed), the platform assigns a fresh uuid on first registration — update any external references accordingly.

## Error Handling

The action will fail if:
- The API key or organization is invalid
- The tools directory does not exist
- A `tool.json` is missing required fields (`toolName`, `description`, `inputSchema`)
- A tool directory is missing `fn.js`
- A `timeout` does not resolve to 5–300 seconds
- The API returns an error during tool registration (the failure message includes the HTTP status and full JSON response body, including Laravel validation errors)

## Development

### Building

```bash
npm install
npm run build
```

The action ships its compiled `dist/` — commit the build output alongside source changes.

## License

This project is licensed under the MIT License.

# Quant Agent Tools Action

A GitHub Action for registering and updating custom tools on the Quant platform for use by AI agents. Reads tool definitions from a directory structure and creates or updates tools via the API.

## Features

- **Tool Registration**: Creates new tools or updates existing ones based on `tool.json`
- **Name-Based Matching**: Detects existing tools by name to avoid duplicates
- **Full Schema Support**: Supports input/output schemas, auth config, execution modes, and more

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `quant_api_key` | Yes | Quant API key |
| `quant_organization` | Yes | Quant organisation name |
| `tools_dir` | Yes | Directory containing tool definitions (default: `tools/`) |
| `base_url` | No | Quant API base URL |

## Outputs

| Output | Description |
|--------|-------------|
| `deployed_tools` | JSON array of deployed tool names |

## Directory Structure

```
tools/
  my-tool/
    tool.json              # Required — tool definition
```

## `tool.json`

Full tool definition matching the Quant AI API:

```json
{
  "toolName": "quantassure_compliance_assessment",
  "description": "Submit a structured compliance assessment",
  "category": "assessment",
  "executionMode": "client",
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
| `executionMode` | No | `edge_function` or `client` |
| `edgeFunctionUrl` | No | URL for edge function execution |
| `isAsync` | No | Whether the tool runs asynchronously |
| `responseMode` | No | `direct` or `llm` |
| `timeout` | No | Timeout in seconds |
| `outputSchema` | No | JSON Schema for tool output |
| `outputSchemaDescription` | No | Description of the output schema |
| `authConfig` | No | Auth configuration (`type`: `bearer`, `api-key`, or `none`) |
| `version` | No | Tool version string |

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

## Error Handling

The action will fail if:
- The API key or organization is invalid
- The tools directory does not exist
- A `tool.json` is missing required fields (`toolName`, `description`, `inputSchema`)
- The API returns an error during tool registration

## Development

### Building

```bash
npm install
npm run build
```

### Testing

```bash
npm test
```

## License

This project is licensed under the MIT License.

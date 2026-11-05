# Upstream attribution and community changes

This package includes a modified OpenViking Codex memory plugin from the upstream examples directory:
https://github.com/volcengine/OpenViking/tree/206054cf150a117b0a4416b4f754c6f4e4e59cb4/examples/codex-memory-plugin

At that commit the plugin manifest identifies version 0.7.7 and Apache-2.0. The examples directory has its own Apache-2.0 LICENSE, preserved verbatim as this package's LICENSE:
https://github.com/volcengine/OpenViking/blob/206054cf150a117b0a4416b4f754c6f4e4e59cb4/examples/LICENSE

The main repository root uses a different license; this source package contains the examples plugin and its example-shared modules, not the OpenViking server. Original attribution and notices are retained. Verification of selected unchanged files is recorded in upstream-provenance.json; an exact match of the entire historical tree is not claimed.

This is a community extension, version 0.7.7-project.4, not an official OpenViking release. Local changes implement project write routing, connection-bound state, configurable directory-level single/combined reads, source-aware MCP reads and retrieval capture filtering. Modified source files carry a community change notice; CHANGES.md lists them.

No user credentials, personal directory paths, real private service addresses, memory data, or conversation logs are included. Configuration examples contain placeholders only. Full source is included under the preserved upstream license and attribution.

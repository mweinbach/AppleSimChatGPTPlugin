# Prepared local MCP review request

Send this through your existing OpenAI partner/developer contact after selecting the release artifact. This file is a draft for the publisher to send; no message has been sent by the preparation workflow.

Subject: Local MCP gallery review for Apple Device Hub

I would like to submit Apple Device Hub, an independent plugin by Max Weinbach, to the shared ChatGPT/Codex plugin directory. The plugin's core features require access to Xcode, CoreSimulator and paired Apple devices on the user's Mac, so it cannot be provided by a centrally hosted MCP endpoint. Your packaging documentation directs this class of plugin to an OpenAI contact for local MCP support.

Repository: https://github.com/mweinbach/AppleSimChatGPTPlugin

Release artifacts: https://github.com/mweinbach/AppleSimChatGPTPlugin/releases/tag/v0.1.3

Plugin ZIP: https://github.com/mweinbach/AppleSimChatGPTPlugin/releases/download/v0.1.3/apple-device-hub-0.1.3.zip

The release includes a complete `apple-device-hub-0.1.3.zip`, alongside separately published npm packages `apple-device-hub-mcp` and `apple-sim-chatgpt-plugin`. The ZIP uses portable Agent Plugins manifests with a single stdio server, bundled JavaScript dependencies, an ad-hoc signed arm64 native simulator capture helper, an embedded viewer and the device-hub skill. It includes listing information, starter prompts, five positive test cases and three negative cases. CI extracts and launches the archive and checks all 19 tools and its global, thread and settings UI entrypoints. The helper is not Developer ID signed or notarized.

Supported prerequisites are an Apple Silicon Mac, Node 22+, Xcode 27 with the Xcode MCP bridge enabled, and a desktop host with local-plugin support. Physical-device interaction remains subject to Apple's pairing and eligibility checks. The native helper uses CoreSimulator display surfaces for simulator video and VideoToolbox for HEVC/H.264. It does not control the Mac desktop. There is no publisher-hosted backend, analytics service, OAuth account or cloud tunnel. Captures and accessibility observations can enter the host/model; live video uses app-only tool metadata. The data-handling document explains these boundaries.

Please confirm the review and distribution route for this local MCP/native-helper plugin, the supported host/platform targeting, and any signing, executable packaging, privacy or review-hardware requirements. I can provide a reviewer walkthrough and a final ZIP after validating the approved host route.

I understand that normal remote-MCP submission, identity verification, policy attestations and publication are separate steps. I am requesting local MCP eligibility review before using that portal flow.

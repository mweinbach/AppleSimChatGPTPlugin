# Apple Device Hub privacy and data handling

Updated September 30, 2026. Publisher: Max Weinbach. Project and support: [AppleSimChatGPTPlugin](https://github.com/mweinbach/AppleSimChatGPTPlugin), [issue tracker](https://github.com/mweinbach/AppleSimChatGPTPlugin/issues).

Apple Device Hub runs on your Mac. It uses Xcode's local device bridge, Apple's device command-line tools, and a bundled native simulator capture helper. The plugin does not operate a publisher-hosted backend, collect analytics, or send device data to a publisher service.

Device discovery reads simulator and paired-device information such as names, identifiers, platforms, runtimes and availability. Connecting creates an interaction session and may boot a simulator. Apple's private interaction session key stays inside the local server; tools expose a separate public session identifier.

Screenshots can contain personal information visible on the device. Accessibility inspection can reveal labels, identifiers, values and other visible interface content. Observation tools return screenshots and a distilled element list to the host and model; the raw accessibility hierarchy is supplied to the viewer in tool metadata. Turning off the hierarchy removes it from the viewer and model output. Apple's bridge may still collect it internally, including to establish logical coordinates.

Live simulator video goes to the viewer through app-only tool metadata rather than model-visible tool content. The embedded host transports that metadata; this implementation makes no claim that the host processes or stores it only on the local computer. The development preview uses a capability-protected WebSocket listener bound to `127.0.0.1`. Video is not uploaded to a publisher backend or saved as a recording by the normal runtime.

The viewer's **Attach current screen** action explicitly adds a fresh screenshot and enabled hierarchy to the conversation using the host's context API. Tool outputs, attachments, conversations and any host-managed logs are subject to the host's own data handling and account settings. For OpenAI hosts, see [OpenAI's privacy policy](https://openai.com/policies/privacy-policy/).

Input tools forward the text, coordinates and device actions needed for your request to Apple's bridge. Changes to device settings persist on the device. Interacting with an app can change app data or send information to that app's services, under that app's own policies.

Active sessions, observations and video capabilities are maintained in process memory. Device command results and screen-processing files use temporary directories removed in `finally` blocks during normal operation; an abnormal termination can leave temporary files for the operating system to clean up. Disconnecting releases the interaction session and video resources. Idle sessions expire after five minutes. The plugin's installed files remain until removed by the user or host. Developer acceptance scripts explicitly save captures and traces in the repository's ignored `artifacts/` directory; these scripts do not run as part of the installed plugin.

Installation and updates contact npm and the host's plugin-management facilities. Source/release downloads and support requests use GitHub. Information you submit in a public issue is publicly visible: remove private screenshots, device identifiers and credentials before posting. The publisher can only receive device data if you deliberately include it in a support request or another communication.

For privacy questions, use the [project issue tracker](https://github.com/mweinbach/AppleSimChatGPTPlugin/issues) without including sensitive material.

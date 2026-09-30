import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { DeviceHub } from "./components/device-hub.js";

createRoot(document.getElementById("root")!).render(createElement(DeviceHub));

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Controls from "./Controls";
import Overlay from "./Overlay";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";

// The window label picks the screen (a query string in the window URL is unreliable on Windows).
const view = getCurrentWindow().label;
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{view === "controls" ? <Controls /> : view === "overlay" ? <Overlay /> : <App />}</React.StrictMode>,
);

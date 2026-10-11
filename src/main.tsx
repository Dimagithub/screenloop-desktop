import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Controls from "./Controls";
import Overlay from "./Overlay";
import "./styles.css";

const view = new URLSearchParams(location.search).get("view");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{view === "controls" ? <Controls /> : view === "overlay" ? <Overlay /> : <App />}</React.StrictMode>,
);

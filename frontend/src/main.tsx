import { render } from "preact";
import App from "./App";
import "./styles.css";
import "./PhotoInformation.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root application container");

render(<App />, root);

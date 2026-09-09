import { render } from "preact";
import App from "./App";
import { authentication, watchAuthentication } from "./auth";
import { AuthPage } from "./AuthPage";
import "./styles.css";
import "./photoCardActions.css";
import "./similarSearch.css";
import "./albums.css";
import "./PhotoInformation.css";
import "./auth.css";
import "./settings.css";
import "./storage.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root application container");

watchAuthentication();
const showAuthentication = authentication.setupRequired || window.location.pathname === "/login"
  || (authentication.enabled && !authentication.authenticated && !authentication.guest);
render(showAuthentication ? <AuthPage setup={authentication.setupRequired} /> : <App />, root);

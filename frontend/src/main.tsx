import { render } from "preact";
import { authentication, watchAuthentication } from "./auth";
import { AuthPage } from "./AuthPage";
import { GalleryEntry } from "./GalleryEntry";
import "./base.css";
import "./auth.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root application container");

watchAuthentication();
const showAuthentication = authentication.setupRequired || window.location.pathname === "/login"
  || (authentication.enabled && !authentication.authenticated && !authentication.guest);
render(showAuthentication ? <AuthPage setup={authentication.setupRequired} /> : <GalleryEntry />, root);

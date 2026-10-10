import App from "./App";
import { ManagementProvider } from "./management";
import "./styles.css";
import "./photoCardActions.css";
import "./selection.css";
import "./similarSearch.css";
import "./albums.css";
import "./directories.css";
import "./PhotoInformation.css";
import "./settings.css";
import "./search.css";
import "./storage.css";
import "./video.css";

export function GalleryApp() {
  return <ManagementProvider><App /></ManagementProvider>;
}

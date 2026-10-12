import App from "./App";
import { ManagementProvider } from "./management";
import "./styles.css";
import "./photoCardActions.css";
import "./selection.css";
import "./albums.css";
import "./directories.css";
import "./PhotoInformation.css";
import "./settings.css";
import "./search.css";
import "./mobileNavigation.css";
import "./imageSearch.css";
import "./duplicates.css";
import "./storage.css";
import "./video.css";

export function GalleryApp() {
  return <ManagementProvider><App /></ManagementProvider>;
}

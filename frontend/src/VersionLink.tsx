import { version } from "../package.json";

export function VersionLink({ className }: { className?: string }) {
  return (
    <a className={className} href="https://github.com/eureka6/Pixhelf" target="_blank" rel="noopener noreferrer" title="GitHub">
      v{version}
    </a>
  );
}

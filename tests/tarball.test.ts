// Checks the real npm pack file list (see @maheidem/pi-panel-kit/testing).
import { tarballTests } from "@maheidem/pi-panel-kit/testing";

await tarballTests(new URL("..", import.meta.url));

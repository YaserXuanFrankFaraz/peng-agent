import { listToolIcons, resolveToolIcon } from "./resources.js";

export const ICON_SIZES = [16, 20, 24, 32, 64, 128, 192, 512];

export function iconForCommand(commandLine) {
  return resolveToolIcon(commandLine).tool;
}

export function listCommandIcons() {
  return listToolIcons().tools;
}

export function iconResourcePath(fileName) {
  return `/resources/tool-icons/${encodeURIComponent(fileName)}`;
}

import { isConnected } from "../connectors/registry.js";
import { teamsPersonal } from "../connectors/teamsPersonal.js";
import { logger } from "../core/log.js";

/**
 * Files for the Teams chat (the ticket report PDF, screenshot previews): uploaded to the OneDrive of the Teams account
 * the plugin signs in with, shared as a view-only link. Best effort: undefined when Teams (personal) is not connected
 * or the upload fails – the caller then shows the local path instead.
 */
export async function shareInTeams(folder: string, files: { local: string; name: string }[]): Promise<{ url: string; files: { name: string; url: string }[] } | undefined> {
  if (!files.length || !isConnected("teams-personal") || process.env.AIW_DISABLE_FILE_SHARE === "1") return undefined;
  try {
    const client = await teamsPersonal();
    if (!client.shareFiles) return undefined;
    return await client.shareFiles(folder, files);
  } catch (e: any) {
    logger.warn("sharing files in Teams failed", { error: e.message });
    return undefined;
  }
}

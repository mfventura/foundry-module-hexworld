/**
 * Tab state for the single HexWorld scene-control group: the palette's first
 * two buttons switch between the "terrain" and "sites" tool sets, which the
 * getSceneControlButtons hook filters by visibility. Lives in its own module
 * so both main.js (hook) and the brush HUD (palette shortcuts) can use it
 * without an import cycle.
 */

let tab = "terrain";

export const HEX_TAB_DEFAULT_TOOL = { terrain: "raise", sites: "site" };

export function hexToolTab() {
  return tab;
}

/** Switch tab (re-rendering the controls) and/or activate a specific tool. */
export function activateHexTab(newTab, tool = null) {
  const target = tool ?? HEX_TAB_DEFAULT_TOOL[newTab] ?? "raise";
  if (tab === newTab) return ui.controls.activate({ control: "hexworld", tool: target });
  tab = newTab;
  // reset rebuilds the tool record (getSceneControlButtons re-fires and reads
  // the new tab); control+tool land via the render options like core does.
  return ui.controls.render({ reset: true, control: "hexworld", tool: target });
}

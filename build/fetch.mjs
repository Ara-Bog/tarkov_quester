// Fetches all Escape from Tarkov quests from the tarkov.dev GraphQL API (Russian)
// and saves the raw response to build/tasks_raw.json.
// Run: node build/fetch.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dir, 'tasks_raw.json');

const QUERY = `{
  tasks(lang: ru) {
    id name normalizedName experience minPlayerLevel
    kappaRequired lightkeeperRequired factionName restartable
    wikiLink taskImageLink
    trader { id name }
    map { id name }
    taskRequirements { task { id name } status }
    failConditions {
      __typename
      ... on TaskObjectiveTaskStatus { task { id name } status }
    }
    objectives {
      id type description optional
      maps { id name }
      ... on TaskObjectiveItem { items { id name shortName iconLink image512pxLink } count foundInRaid requiredKeys { id name } zones { map { name } position { x z } } }
      ... on TaskObjectiveMark { markerItem { id name shortName iconLink image512pxLink } requiredKeys { id name } zones { map { name } position { x z } } }
      ... on TaskObjectiveQuestItem { questItem { id name iconLink image512pxLink } count zones { map { name } position { x z } } possibleLocations { map { name } positions { x z } } }
      ... on TaskObjectiveShoot { targetNames count shotType usingWeapon { id name shortName iconLink image512pxLink } requiredKeys { id name } zones { map { name } position { x z } } }
      ... on TaskObjectiveExtract { exitName requiredKeys { id name } }
      ... on TaskObjectiveUseItem { useAny { id name shortName iconLink image512pxLink } count zones { map { name } position { x z } } }
      ... on TaskObjectiveBuildItem { item { id name shortName iconLink image512pxLink } }
      ... on TaskObjectiveBasic { requiredKeys { id name } zones { map { name } position { x z } } }
    }
  }
}`;

const res = await fetch('https://api.tarkov.dev/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: QUERY }),
});
if (!res.ok) throw new Error('HTTP ' + res.status);
const json = await res.json();
if (json.errors) { console.error(JSON.stringify(json.errors, null, 2)); throw new Error('GraphQL errors'); }

fs.writeFileSync(OUT, JSON.stringify(json), 'utf8');
console.log(`Fetched ${json.data.tasks.length} tasks -> ${path.relative(path.join(__dir, '..'), OUT)} (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)`);

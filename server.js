const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WebSocket.Server({ server });

// World state
const WORLD_W = 200;
const WORLD_H = 200;
const TILE_EMPTY = 0, TILE_GRASS = 1, TILE_FOREST = 2, TILE_WATER = 3,
      TILE_RUIN = 4, TILE_STONE = 5, TILE_CAVE = 6, TILE_VILLAGE = 7;

// Generate world map
function generateWorld() {
  const map = [];
  for (let y = 0; y < WORLD_H; y++) {
    map[y] = [];
    for (let x = 0; x < WORLD_W; x++) {
      const nx = x / WORLD_W, ny = y / WORLD_H;
      const n = noise(nx * 6, ny * 6);
      if (n < -0.4) map[y][x] = TILE_WATER;
      else if (n < 0.0) map[y][x] = TILE_GRASS;
      else if (n < 0.35) map[y][x] = TILE_FOREST;
      else if (n < 0.55) map[y][x] = TILE_STONE;
      else map[y][x] = TILE_FOREST;
    }
  }
  // Place ruins & villages
  for (let i = 0; i < 18; i++) {
    const rx = 5 + Math.floor(Math.random() * (WORLD_W - 10));
    const ry = 5 + Math.floor(Math.random() * (WORLD_H - 10));
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++)
        if (map[ry+dy] && map[ry+dy][rx+dx] !== TILE_WATER)
          map[ry+dy][rx+dx] = i % 5 === 0 ? TILE_VILLAGE : TILE_RUIN;
  }
  // Caves
  for (let i = 0; i < 12; i++) {
    const cx = 5 + Math.floor(Math.random() * (WORLD_W - 10));
    const cy = 5 + Math.floor(Math.random() * (WORLD_H - 10));
    map[cy][cx] = TILE_CAVE;
  }
  return map;
}

// Simple noise
function noise(x, y) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const u = fade(xf), v = fade(yf);
  const a = p[X] + Y, b = p[X+1] + Y;
  return lerp(v,
    lerp(u, grad(p[a], xf, yf), grad(p[b], xf-1, yf)),
    lerp(u, grad(p[a+1], xf, yf-1), grad(p[b+1], xf-1, yf-1))
  );
}
function fade(t) { return t*t*t*(t*(t*6-15)+10); }
function lerp(t, a, b) { return a + t*(b-a); }
function grad(hash, x, y) {
  const h = hash & 3;
  const u = h < 2 ? x : y, v = h < 2 ? y : x;
  return ((h&1)?-u:u) + ((h&2)?-v:v);
}
const p = [];
for (let i = 0; i < 256; i++) p[i] = i;
for (let i = 255; i > 0; i--) {
  const j = Math.floor(Math.random()*(i+1));
  [p[i],p[j]] = [p[j],p[i]];
}
for (let i = 0; i < 256; i++) p[256+i] = p[i];

const worldMap = generateWorld();

// Resources on map (trees, stones, etc.)
const resources = [];
for (let y = 0; y < WORLD_H; y++) {
  for (let x = 0; x < WORLD_W; x++) {
    if (worldMap[y][x] === TILE_FOREST && Math.random() < 0.25)
      resources.push({ id: `r_${x}_${y}`, type: 'tree', x: x*32+16, y: y*32+16, hp: 3 });
    if (worldMap[y][x] === TILE_STONE && Math.random() < 0.3)
      resources.push({ id: `r_s${x}_${y}`, type: 'rock', x: x*32+16, y: y*32+16, hp: 5 });
    if (worldMap[y][x] === TILE_CAVE && Math.random() < 0.6)
      resources.push({ id: `r_c${x}_${y}`, type: 'ore', x: x*32+16, y: y*32+16, hp: 4 });
  }
}

// Animals
const animals = [];
const ANIMAL_TYPES = [
  { type: 'deer', aggressive: false, speed: 1.2, hp: 40, drop: 'meat', color: '#c8842a' },
  { type: 'rabbit', aggressive: false, speed: 1.8, hp: 15, drop: 'meat', color: '#d4b896' },
  { type: 'wolf', aggressive: true, speed: 1.5, hp: 60, drop: 'hide', color: '#7a7a8a' },
  { type: 'boar', aggressive: true, speed: 1.3, hp: 80, drop: 'meat', color: '#8b4513' },
  { type: 'bear', aggressive: true, speed: 1.0, hp: 150, drop: 'hide', color: '#5c4033' },
  { type: 'spirit_fox', aggressive: false, speed: 2.0, hp: 30, drop: 'magic_crystal', color: '#a855f7', magic: true },
];
for (let i = 0; i < 120; i++) {
  const t = ANIMAL_TYPES[Math.floor(Math.random() * ANIMAL_TYPES.length)];
  animals.push({
    id: `a_${i}`,
    ...t,
    x: (5 + Math.random() * (WORLD_W - 10)) * 32,
    y: (5 + Math.random() * (WORLD_H - 10)) * 32,
    vx: 0, vy: 0,
    targetX: null, targetY: null,
    moveTimer: Math.random() * 200,
    alive: true,
    respawnTimer: 0,
  });
}

// Items on ground (from ruins/villages)
const groundItems = [];
for (let i = 0; i < 80; i++) {
  const types = ['bandage','food','water_flask','rope','iron_scrap','old_cloth','arrow_bundle'];
  groundItems.push({
    id: `gi_${i}`,
    type: types[Math.floor(Math.random()*types.length)],
    x: (5 + Math.random()*(WORLD_W-10))*32,
    y: (5 + Math.random()*(WORLD_H-10))*32,
    alive: true,
  });
}

// Players
const players = new Map();
let nextPid = 1;

// Crafting recipes
const RECIPES = {
  wooden_axe: { wood: 5 },
  wooden_spear: { wood: 6, rope: 1 },
  bow: { wood: 4, rope: 2 },
  campfire: { wood: 8, stone: 2 },
  shelter: { wood: 20, rope: 4 },
  bandage_craft: { old_cloth: 2 },
  arrow: { wood: 2, iron_scrap: 1 },
  iron_knife: { iron_scrap: 4, wood: 2 },
};

function broadcast(data, exceptId) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN && c.playerId !== exceptId)
      c.send(msg);
  });
}
function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

wss.on('connection', (ws) => {
  ws.playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const pid = `p${nextPid++}`;
      ws.playerId = pid;
      // Spawn on grass
      let sx = 100*32, sy = 100*32;
      for (let attempt = 0; attempt < 200; attempt++) {
        const tx = 10 + Math.floor(Math.random()*(WORLD_W-20));
        const ty = 10 + Math.floor(Math.random()*(WORLD_H-20));
        if (worldMap[ty][tx] === TILE_GRASS || worldMap[ty][tx] === TILE_VILLAGE) {
          sx = tx*32 + 16; sy = ty*32 + 16; break;
        }
      }
      const player = {
        id: pid, name: msg.name || `Survivor_${pid}`,
        x: sx, y: sy,
        hp: 100, maxHp: 100,
        hunger: 100, thirst: 100, stamina: 100,
        inventory: {},
        equipped: null,
        alive: true,
        kills: 0,
        color: `hsl(${Math.random()*360},70%,60%)`,
      };
      players.set(pid, player);

      // Send world state to new player
      send(ws, {
        type: 'init',
        pid,
        map: worldMap,
        players: [...players.values()],
        resources: resources.filter(r => r.hp > 0),
        animals: animals.filter(a => a.alive),
        groundItems: groundItems.filter(g => g.alive),
        recipes: RECIPES,
        worldW: WORLD_W, worldH: WORLD_H,
        timeOfDay: timeOfDay,
      });

      broadcast({ type: 'player_join', player }, pid);
      broadcast({ type: 'chat', name: '🌍 World', text: `${player.name} has entered The Reclaimed.`, system: true });
    }

    if (!ws.playerId) return;
    const player = players.get(ws.playerId);
    if (!player || !player.alive) return;

    if (msg.type === 'move') {
      const nx = Math.max(16, Math.min(WORLD_W*32-16, msg.x));
      const ny = Math.max(16, Math.min(WORLD_H*32-16, msg.y));
      const tx = Math.floor(nx/32), ty = Math.floor(ny/32);
      if (worldMap[ty] && worldMap[ty][tx] !== TILE_WATER) {
        player.x = nx; player.y = ny;
        broadcast({ type: 'player_move', id: ws.playerId, x: nx, y: ny }, ws.playerId);
      }
    }

    if (msg.type === 'chat') {
      const text = String(msg.text).slice(0, 200);
      broadcast({ type: 'chat', name: player.name, text, id: ws.playerId });
      send(ws, { type: 'chat', name: player.name, text, id: ws.playerId });
    }

    if (msg.type === 'harvest') {
      const res = resources.find(r => r.id === msg.rid && r.hp > 0);
      if (!res) return;
      const dist = Math.hypot(res.x - player.x, res.y - player.y);
      if (dist > 80) return;
      res.hp--;
      let item = res.type === 'tree' ? 'wood' : res.type === 'rock' ? 'stone' : 'ore';
      player.inventory[item] = (player.inventory[item] || 0) + 1;
      if (res.hp <= 0) {
        broadcast({ type: 'resource_depleted', rid: res.id });
        setTimeout(() => { res.hp = res.type === 'tree' ? 3 : res.type === 'rock' ? 5 : 4;
          broadcast({ type: 'resource_respawn', resource: res }); }, 60000);
      }
      send(ws, { type: 'inventory', inventory: player.inventory });
      send(ws, { type: 'harvest_ok', item, rid: res.id, hp: res.hp });
    }

    if (msg.type === 'pickup') {
      const gi = groundItems.find(g => g.id === msg.gid && g.alive);
      if (!gi) return;
      const dist = Math.hypot(gi.x - player.x, gi.y - player.y);
      if (dist > 60) return;
      gi.alive = false;
      player.inventory[gi.type] = (player.inventory[gi.type] || 0) + 1;
      send(ws, { type: 'inventory', inventory: player.inventory });
      broadcast({ type: 'item_picked', gid: gi.id });
    }

    if (msg.type === 'craft') {
      const recipe = RECIPES[msg.item];
      if (!recipe) return;
      for (const [mat, amt] of Object.entries(recipe))
        if ((player.inventory[mat] || 0) < amt) { send(ws, { type: 'craft_fail', reason: 'Missing materials' }); return; }
      for (const [mat, amt] of Object.entries(recipe))
        player.inventory[mat] -= amt;
      player.inventory[msg.item] = (player.inventory[msg.item] || 0) + 1;
      send(ws, { type: 'inventory', inventory: player.inventory });
      send(ws, { type: 'craft_ok', item: msg.item });
    }

    if (msg.type === 'use_item') {
      const item = msg.item;
      if (!player.inventory[item] || player.inventory[item] <= 0) return;
      if (item === 'food' || item === 'meat') { player.hunger = Math.min(100, player.hunger + 30); player.inventory[item]--; }
      if (item === 'water_flask') { player.thirst = Math.min(100, player.thirst + 40); player.inventory[item]--; }
      if (item === 'bandage' || item === 'bandage_craft') { player.hp = Math.min(player.maxHp, player.hp + 25); player.inventory[item]--; }
      send(ws, { type: 'stats', hp: player.hp, hunger: player.hunger, thirst: player.thirst, stamina: player.stamina });
      send(ws, { type: 'inventory', inventory: player.inventory });
    }

    if (msg.type === 'equip') {
      player.equipped = msg.item;
      send(ws, { type: 'equipped', item: msg.item });
    }

    if (msg.type === 'attack_player') {
      const target = players.get(msg.tid);
      if (!target || !target.alive) return;
      const dist = Math.hypot(target.x - player.x, target.y - player.y);
      if (dist > 80) return;
      const dmg = getWeaponDamage(player.equipped);
      target.hp -= dmg;
      if (target.hp <= 0) {
        target.alive = false;
        target.hp = 0;
        player.kills++;
        broadcast({ type: 'player_died', id: target.id, killer: player.name });
        const tw = [...wss.clients].find(c => c.playerId === target.id);
        if (tw) send(tw, { type: 'you_died', killer: player.name });
        // Drop some inventory
        Object.entries(target.inventory).forEach(([item, qty]) => {
          if (qty > 0) groundItems.push({ id: `gi_drop_${Date.now()}_${item}`, type: item, x: target.x + (Math.random()-0.5)*40, y: target.y + (Math.random()-0.5)*40, alive: true });
        });
      }
      broadcast({ type: 'player_hit', id: target.id, hp: target.hp, dmg });
      send(ws, { type: 'attack_ok' });
    }

    if (msg.type === 'attack_animal') {
      const animal = animals.find(a => a.id === msg.aid && a.alive);
      if (!animal) return;
      const dist = Math.hypot(animal.x - player.x, animal.y - player.y);
      if (dist > 90) return;
      const dmg = getWeaponDamage(player.equipped);
      animal.hp -= dmg;
      if (animal.hp <= 0) {
        animal.alive = false;
        const drop = animal.drop;
        const qty = animal.magic ? 1 : 1 + Math.floor(Math.random()*2);
        player.inventory[drop] = (player.inventory[drop] || 0) + qty;
        send(ws, { type: 'inventory', inventory: player.inventory });
        broadcast({ type: 'animal_died', aid: animal.id, drop, qty, x: animal.x, y: animal.y });
        animal.respawnTimer = 30000 + Math.random()*60000;
      } else {
        if (animal.aggressive) { animal.targetX = player.x; animal.targetY = player.y; }
        broadcast({ type: 'animal_hit', aid: animal.id, hp: animal.hp });
      }
    }

    if (msg.type === 'respawn') {
      player.alive = true;
      player.hp = 100; player.hunger = 100; player.thirst = 100; player.stamina = 100;
      player.inventory = {};
      player.equipped = null;
      player.name = msg.name || `Survivor_${Math.floor(Math.random()*9999)}`;
      player.kills = 0;
      // New spawn
      for (let attempt = 0; attempt < 200; attempt++) {
        const tx = 10 + Math.floor(Math.random()*(WORLD_W-20));
        const ty = 10 + Math.floor(Math.random()*(WORLD_H-20));
        if (worldMap[ty][tx] === TILE_GRASS) { player.x = tx*32+16; player.y = ty*32+16; break; }
      }
      broadcast({ type: 'player_respawn', player });
      broadcast({ type: 'chat', name: '🌍 World', text: `${player.name} walks The Reclaimed once more.`, system: true });
      send(ws, { type: 'respawn_ok', player });
    }
  });

  ws.on('close', () => {
    if (ws.playerId) {
      const player = players.get(ws.playerId);
      players.delete(ws.playerId);
      broadcast({ type: 'player_leave', id: ws.playerId });
      if (player) broadcast({ type: 'chat', name: '🌍 World', text: `${player.name} has left.`, system: true });
    }
  });
});

function getWeaponDamage(weapon) {
  const dmg = { wooden_axe:18, wooden_spear:22, iron_knife:28, bow:20, arrow:20, null:10, undefined:10 };
  return (dmg[weapon] || 10) + Math.floor(Math.random()*6);
}

// Game loop
let timeOfDay = 0; // 0-1, 0=dawn, 0.5=noon, 1=midnight
let tick = 0;

setInterval(() => {
  tick++;
  timeOfDay = (timeOfDay + 0.000025) % 1; // ~30 min real time per full day

  // Survival drain
  if (tick % 100 === 0) {
    players.forEach((p, pid) => {
      if (!p.alive) return;
      p.hunger = Math.max(0, p.hunger - 1);
      p.thirst = Math.max(0, p.thirst - 1.5);
      p.stamina = Math.min(100, p.stamina + 5);
      if (p.hunger === 0 || p.thirst === 0) p.hp = Math.max(0, p.hp - 2);
      if (p.hp <= 0 && p.alive) {
        p.alive = false;
        broadcast({ type: 'player_died', id: pid, killer: 'starvation' });
        const tw = [...wss.clients].find(c => c.playerId === pid);
        if (tw) send(tw, { type: 'you_died', killer: 'starvation/dehydration' });
      }
      const ws = [...wss.clients].find(c => c.playerId === pid);
      if (ws) send(ws, { type: 'stats', hp: p.hp, hunger: p.hunger, thirst: p.thirst, stamina: p.stamina });
    });
  }

  // Animal movement
  if (tick % 20 === 0) {
    animals.forEach(a => {
      if (!a.alive) {
        a.respawnTimer -= 20*50;
        if (a.respawnTimer <= 0) {
          a.alive = true;
          a.hp = ANIMAL_TYPES.find(t=>t.type===a.type)?.hp || 50;
          a.x = (5+Math.random()*(WORLD_W-10))*32;
          a.y = (5+Math.random()*(WORLD_H-10))*32;
          broadcast({ type: 'animal_respawn', animal: a });
        }
        return;
      }
      a.moveTimer -= 20;
      if (a.moveTimer <= 0 || (a.targetX && Math.hypot(a.x-a.targetX, a.y-a.targetY) < 10)) {
        a.targetX = a.x + (Math.random()-0.5)*200;
        a.targetY = a.y + (Math.random()-0.5)*200;
        a.targetX = Math.max(32, Math.min((WORLD_W-2)*32, a.targetX));
        a.targetY = Math.max(32, Math.min((WORLD_H-2)*32, a.targetY));
        a.moveTimer = 100 + Math.random()*300;
      }
      // Aggressive animals chase nearby players
      if (a.aggressive) {
        let closest = null, closestDist = 200;
        players.forEach(p => {
          if (!p.alive) return;
          const d = Math.hypot(p.x - a.x, p.y - a.y);
          if (d < closestDist) { closestDist = d; closest = p; }
        });
        if (closest) { a.targetX = closest.x; a.targetY = closest.y; }
        // Attack player
        if (closest && closestDist < 40) {
          closest.hp = Math.max(0, closest.hp - (a.type==='bear'?8:a.type==='wolf'?5:6));
          if (closest.hp <= 0 && closest.alive) {
            closest.alive = false;
            broadcast({ type: 'player_died', id: closest.id, killer: a.type });
            const tw = [...wss.clients].find(c => c.playerId === closest.id);
            if (tw) send(tw, { type: 'you_died', killer: a.type });
          }
        }
      }
      const dx = a.targetX - a.x, dy = a.targetY - a.y;
      const len = Math.hypot(dx, dy) || 1;
      a.x += (dx/len)*a.speed*2;
      a.y += (dy/len)*a.speed*2;
    });
    broadcast({ type: 'animals_update', animals: animals.filter(a=>a.alive).map(a=>({id:a.id,x:a.x,y:a.y,alive:a.alive})) });
  }

  // Broadcast time
  if (tick % 50 === 0) broadcast({ type: 'time', tod: timeOfDay });

}, 50);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌿 The Reclaimed server running on port ${PORT}`));

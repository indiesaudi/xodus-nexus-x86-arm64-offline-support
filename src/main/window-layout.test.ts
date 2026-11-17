import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {transpileModule,ScriptTarget} from 'typescript';
import {nativeDialogsAvailable} from './launcher-environment.js';

type WindowState = {x:number;y:number;width:number;height:number;maximized:boolean};
type Area = {x:number;y:number;width:number;height:number};

const source=readFileSync('src/main/index.ts','utf8');
const start=source.indexOf('  const smokeScreenshot = process.env.XODUS_NEXUS_SMOKE_SCREENSHOT;');
const end=source.indexOf('  const restoreOverlayShortcut=',start);
if (start < 0 || end < start) throw new Error('Could not extract the production window creation block.');
const production=source.slice(start,end).replace(/import\.meta\.url/g,JSON.stringify('file:///tmp/index.js'));
const code=transpileModule('(()=>{let mainWindow;'+production+'return {mainWindow,gamingMode,windowState,hiddenCapture,bounds,area,tooLarge};})()',
  {compilerOptions:{target:ScriptTarget.ES2022}}).outputText;

class BrowserWindowStub {
  options: Record<string,any>;
  webContents = {on:vi.fn(),setWindowOpenHandler:vi.fn()};
  on = vi.fn();
  once = vi.fn();
  maximize = vi.fn();
  show = vi.fn();
  setMenu = vi.fn();
  setMenuBarVisibility = vi.fn();
  isMinimized = vi.fn(() => false);
  getNormalBounds = vi.fn(() => ({x:0,y:0,width:1000,height:700}));
  isMaximized = vi.fn(() => false);
  constructor(options: Record<string,any>) { this.options = options; windows.push(this); }
}

let windows: BrowserWindowStub[] = [];

function harness(options:{
  width?:number;height?:number;saved?:WindowState;secondary?:Area;env?:NodeJS.ProcessEnv;platform?:string;demoMode?:boolean;
} = {}) {
  const width = options.width ?? 2560, height = options.height ?? 1440;
  const primary:Area = {x:0,y:0,width,height};
  const secondary = options.secondary;
  const env = options.env ?? {};
  const matching = vi.fn(() => ({workArea:secondary ?? primary}));
  const readWindowState = vi.fn(() => options.saved);
  const saveWindowState = vi.fn();
  windows = [];
  const context = createContext({
    process:{env,platform:options.platform ?? 'linux'},
    demoMode:options.demoMode ?? false,
    readWindowState,
    saveWindowState,
    restoredBoundsOnScreen:() => true,
    screen:{getPrimaryDisplay:() => ({workArea:primary}),getDisplayMatching:matching},
    BrowserWindow:BrowserWindowStub,
    launcherDisplayName:'Nexus Launcher',
    fileURLToPath:(url:URL) => String(url),
    URL,
    path:{join:(...parts:string[]) => parts.join('/')},
    __dirname:'/tmp',
    console,
    nativeDialogsAvailable:() => nativeDialogsAvailable(env),
  });
  const result = runInContext(code,context) as {
    mainWindow:BrowserWindowStub;gamingMode:boolean;windowState?:WindowState;hiddenCapture:boolean;
    bounds:WindowState;area:Area;tooLarge:boolean;
  };
  return {...result,window:result.mainWindow,windows,matching,readWindowState,saveWindowState};
}

it('extracts the actual production window creation and lifecycle block',()=>{
  expect(production).toContain('fullscreen: gamingMode');
  expect(production).toContain('mainWindow.setMenu(null)');
  expect(production).toContain('mainWindow.setMenuBarVisibility(false)');
  expect(production).toContain('if (!hiddenCapture && !gamingMode)');
});

it.each([[1280,800],[800,480],[640,480]])('lets the compositor maximize first startup on %ix%i',(width,height)=>{
  const r=harness({width,height});
  expect(r.tooLarge).toBe(true);
  expect(r.bounds.width).toBeLessThanOrEqual(width);
  expect(r.bounds.height).toBeLessThanOrEqual(height);
  expect(r.matching).not.toHaveBeenCalled();
  expect(r.window.maximize).toHaveBeenCalledOnce();
  expect(r.window.options.fullscreen).toBe(false);
});

it('keeps normal desktop startup centered and unmaximized',()=>{
  const r=harness({width:2560,height:1440});
  expect(r.tooLarge).toBe(false);
  expect(r.bounds).toMatchObject({width:1440,height:900,x:560,y:270});
  expect(r.window.options.fullscreen).toBe(false);
  expect(r.readWindowState).toHaveBeenCalledOnce();
  expect(r.window.maximize).not.toHaveBeenCalled();
  const close = r.window.on.mock.calls.find(call => call[0] === 'close')?.[1] as (() => void) | undefined;
  close?.();
  expect(r.saveWindowState).toHaveBeenCalledWith(r.window);
});

it('uses the restored secondary monitor rather than incorrectly maximizing against the primary',()=>{
  const saved={x:1920,y:0,width:1600,height:900,maximized:false},secondary={x:1920,y:0,width:2560,height:1440};
  const r=harness({width:1280,height:800,saved,secondary});
  expect(r.tooLarge).toBe(false);
  expect(r.area).toEqual(secondary);
  expect(r.bounds).toEqual(saved);
  expect(r.matching).toHaveBeenCalledWith({x:1920,y:0,width:1600,height:900});
  expect(r.window.options.fullscreen).toBe(false);
});

it('maximizes a saved oversized window on the smaller secondary monitor',()=>{
  const r=harness({width:2560,height:1440,saved:{x:2560,y:0,width:1440,height:900,maximized:false},secondary:{x:2560,y:0,width:1280,height:720}});
  expect(r.tooLarge).toBe(true);
  expect(r.window.maximize).toHaveBeenCalledOnce();
});

it('retains restored maximization, work-area minimums and the desktop save lifecycle',()=>{
  const r=harness({width:2560,height:1440,saved:{x:20,y:20,width:1000,height:700,maximized:true}});
  expect(r.bounds.maximized).toBe(true);
  expect(r.window.options.minWidth).toBe(800);
  expect(r.window.options.minHeight).toBe(600);
  expect(r.window.maximize).toHaveBeenCalledOnce();
  expect(r.window.on).toHaveBeenCalledWith('close',expect.any(Function));
});

it('enters fullscreen in Linux gamescope Gaming Mode without reading or saving desktop state',()=>{
  const r=harness({env:{XDG_CURRENT_DESKTOP:'gamescope'}});
  expect(r.gamingMode).toBe(true);
  expect(r.hiddenCapture).toBe(false);
  expect(r.windowState).toBeUndefined();
  expect(r.readWindowState).not.toHaveBeenCalled();
  expect(r.window.options.fullscreen).toBe(true);
  expect(r.window.options.show).toBe(true);
  expect(r.window.options.webPreferences.offscreen).toBe(false);
  expect(r.window.once).toHaveBeenCalledWith('ready-to-show',expect.any(Function));
  expect(r.window.setMenu).toHaveBeenCalledWith(null);
  expect(r.window.setMenuBarVisibility).toHaveBeenCalledWith(false);
  expect(r.window.maximize).not.toHaveBeenCalled();
  expect(r.window.on).not.toHaveBeenCalled();
  expect(r.saveWindowState).not.toHaveBeenCalled();
});

it.each([
  ['smoke',{XODUS_NEXUS_SMOKE_SCREENSHOT:'/tmp/smoke.png'},false],
  ['demo',{XODUS_DEMO_CAPTURE_DIR:'/tmp/demo'},true],
] as const)('keeps hidden %s capture non-fullscreen and invisible in Gaming Mode environment',(_name,env,demoMode)=>{
  const r=harness({env:{...env,XDG_CURRENT_DESKTOP:'gamescope'},demoMode});
  expect(r.hiddenCapture).toBe(true);
  expect(r.gamingMode).toBe(false);
  expect(r.window.options.fullscreen).toBe(false);
  expect(r.window.options.show).toBe(false);
  expect(r.window.options.webPreferences.offscreen).toBe(true);
  expect(r.window.once).not.toHaveBeenCalled();
  expect(r.readWindowState).not.toHaveBeenCalled();
  expect(r.window.setMenu).not.toHaveBeenCalled();
  expect(r.window.maximize).not.toHaveBeenCalled();
  expect(r.window.on).not.toHaveBeenCalled();
});

it('does not enter Gaming Mode for a desktop Steam shortcut with SteamGameId on KDE',()=>{
  const r=harness({env:{XDG_CURRENT_DESKTOP:'KDE',SteamGameId:'123',SteamAppId:'123'}});
  expect(r.gamingMode).toBe(false);
  expect(r.window.options.fullscreen).toBe(false);
  expect(r.window.options.webPreferences.offscreen).toBe(false);
  expect(r.readWindowState).toHaveBeenCalledOnce();
  expect(r.window.on).toHaveBeenCalledWith('close',expect.any(Function));
});

it.each([
  ['KDE:gamescope',true],
  ['KDE:GameScope',true],
  ['gamescope:KDE',true],
  ['KDE:gamescope-foo',false],
  ['KDE',false],
] as const)('handles XDG_CURRENT_DESKTOP token %s',(desktop,expected)=>{
  const r=harness({env:{XDG_CURRENT_DESKTOP:desktop}});
  expect(r.gamingMode).toBe(expected);
  expect(r.window.options.fullscreen).toBe(expected);
});

it('does not enter Gaming Mode on non-Linux even with gamescope environment',()=>{
  const r=harness({platform:'darwin',env:{XDG_CURRENT_DESKTOP:'gamescope'}});
  expect(r.gamingMode).toBe(false);
  expect(r.window.options.fullscreen).toBe(false);
  expect(r.readWindowState).toHaveBeenCalledOnce();
});

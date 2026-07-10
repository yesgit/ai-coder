import { useEffect, useRef, useState, useCallback } from "react";
import "@xterm/xterm/css/xterm.css";

// @xterm/xterm v5 exports Terminal as default (CJS compat via esModuleInterop)
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

interface TerminalPanelProps {
  projectPath: string;
  onClose: () => void;
}

export default function TerminalPanel({ projectPath, onClose }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const [panelHeight, setPanelHeight] = useState(280);
  const draggingRef = useRef(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);

  // Start terminal when projectPath changes
  useEffect(() => {
    if (!projectPath || !containerRef.current) return;

    let terminated = false;

    const initTerminal = async () => {
      const terminal = new Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
        theme: {
          background: "#1a1b1e",
          foreground: "#e4e4e7",
          cursor: "#e4e4e7",
          selectionBackground: "#3b3f4a",
          black: "#1a1b1e",
          red: "#f87171",
          green: "#4ade80",
          yellow: "#fbbf24",
          blue: "#60a5fa",
          magenta: "#c084fc",
          cyan: "#22d3ee",
          white: "#e4e4e7",
          brightBlack: "#52525b",
          brightRed: "#fca5a5",
          brightGreen: "#86efac",
          brightYellow: "#fde68a",
          brightBlue: "#93c5fd",
          brightMagenta: "#d8b4fe",
          brightCyan: "#67e8f9",
          brightWhite: "#fafafa"
        },
        allowProposedApi: true,
        rows: 24,
        cols: 100
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      if (containerRef.current && !terminated) {
        terminal.open(containerRef.current);
      }

      // Auto-fit after a brief delay for the container to settle
      setTimeout(() => {
        if (!terminated) fitAddon.fit();
      }, 50);

      // Start the PTY
      const cols = terminal.cols;
      const rows = terminal.rows;
      const tid = await window.aiCoder.terminalStart(projectPath, cols, rows);
      if (terminated) {
        window.aiCoder.terminalDestroy(tid);
        return;
      }
      terminalIdRef.current = tid;

      // Forward terminal input to PTY
      terminal.onData((data) => {
        if (terminalIdRef.current) {
          window.aiCoder.terminalWrite(terminalIdRef.current, data);
        }
      });

      // Listen for PTY output
      const unsubscribe = window.aiCoder.onTerminalData(tid, (data: string) => {
        if (!terminated && terminalRef.current) {
          terminalRef.current.write(data);
        }
      });

      // Resize handler
      const handleResize = () => {
        if (fitAddonRef.current && !terminated) {
          fitAddonRef.current.fit();
          if (terminalIdRef.current && terminalRef.current) {
            window.aiCoder.terminalResize(
              terminalIdRef.current,
              terminalRef.current.cols,
              terminalRef.current.rows
            );
          }
        }
      };
      const resizeObserver = new ResizeObserver(() => {
        handleResize();
      });
      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
      }

      // Cleanup
      return () => {
        unsubscribe();
        resizeObserver.disconnect();
      };
    };

    initTerminal().catch(console.error);

    return () => {
      terminated = true;
      if (terminalIdRef.current) {
        window.aiCoder.terminalDestroy(terminalIdRef.current);
        terminalIdRef.current = null;
      }
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
  }, [projectPath]);

  // Resize handle drag logic
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    draggingRef.current = true;
    dragStartY.current = e.clientY;
    dragStartHeight.current = panelHeight;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
  }, [panelHeight]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = dragStartY.current - e.clientY;
      const newHeight = Math.max(120, Math.min(600, dragStartHeight.current + delta));
      setPanelHeight(newHeight);
    };
    const handleMouseUp = () => {
      if (draggingRef.current) {
        draggingRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        // Trigger fit after resize
        setTimeout(() => {
          fitAddonRef.current?.fit();
          if (terminalIdRef.current && terminalRef.current) {
            window.aiCoder.terminalResize(
              terminalIdRef.current,
              terminalRef.current.cols,
              terminalRef.current.rows
            );
          }
        }, 0);
      }
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  return (
    <div className="terminal-panel" style={{ height: panelHeight }}>
      <div className="terminal-resize-handle" onMouseDown={handleMouseDown} />
      <div className="terminal-header">
        <span className="terminal-title">Claude 终端</span>
        <small className="terminal-cwd" title={projectPath}>{projectPath}</small>
        <button className="icon-btn terminal-close" onClick={onClose} title="关闭终端">×</button>
      </div>
      <div className="terminal-container" ref={containerRef} />
    </div>
  );
}

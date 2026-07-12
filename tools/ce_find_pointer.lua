--[[
  DD2 pointer-capture helper for Cheat Engine's Lua engine.

  What it does:
    - Sets a WRITE breakpoint on a currently-valid player-position address.
    - When the game's movement code writes to it, captures the instruction,
      all registers, and works out which [register + offset] points at the
      target — i.e. the struct base pointer and the final offset of the chain.
    - Appends the findings to  %TEMP%\dd2_ce_out.txt  (override with outPath below).

  How to run:
    1. In Cheat Engine, attach to DD2.exe (Process list -> DD2.exe).
    2. EDIT the `target` value below to a CURRENTLY-VALID position float
       address. (These reallocate, so re-find it with a fresh Float scan if
       0x47A55E10 no longer shows a sane value. Any one of x/height/y works.)
    3. Table menu -> "Show Cheat Table Lua Script" -> paste this -> Execute.
    4. Move your character for a few seconds so the write fires.
    5. Read the captured base pointer + offset out of the output file.

  After we have the base pointer + offset, you pointer-scan the BASE POINTER
  (or the target) in CE's GUI scanner to get the static path.
]]

local target = 0x4889D4E0          -- <<< EDIT to a current valid position address
-- CE's working directory is wherever the CE executable lives, so a relative path
-- would land somewhere unhelpful. %TEMP% is a stable, machine-independent spot.
local outPath = os.getenv("TEMP") .. [[\dd2_ce_out.txt]]
local maxCaptures = 6

-- Attach if not already attached.
if getOpenedProcessID() == nil or getOpenedProcessID() == 0 then
  openProcess("DD2.exe")
end

local moduleBase = getAddress("DD2.exe")

-- Fresh output file with a header.
do
  local f = io.open(outPath, "w")
  f:write(string.format("DD2.exe module base = 0x%X\n", moduleBase))
  f:write(string.format("target address      = 0x%X\n", target))
  f:write(string.format("target - moduleBase = 0x%X\n\n", target - moduleBase))
  f:close()
end

captureCount = 0

function debugger_onBreakpoint()
  local out = {}
  out[#out+1] = string.format("--- hit #%d ---", captureCount + 1)
  out[#out+1] = "INSTR: " .. disassemble(RIP)

  local regs = {
    RAX=RAX, RBX=RBX, RCX=RCX, RDX=RDX, RSI=RSI, RDI=RDI, RBP=RBP,
    R8=R8, R9=R9, R10=R10, R11=R11, R12=R12, R13=R13, R14=R14, R15=R15,
  }

  -- Which register + small offset lands exactly on the target?
  for name, val in pairs(regs) do
    if val ~= nil then
      local off = target - val
      if off >= 0 and off < 0x3000 then
        out[#out+1] = string.format("  BASE MATCH: [%s + 0x%X] = target   base=0x%X", name, off, val)
      end
    end
  end

  -- Dump all registers for reference.
  out[#out+1] = string.format("  RAX=%X RBX=%X RCX=%X RDX=%X RSI=%X RDI=%X RBP=%X",
    RAX, RBX, RCX, RDX, RSI, RDI, RBP)
  out[#out+1] = string.format("  R8=%X R9=%X R10=%X R11=%X R12=%X R13=%X R14=%X R15=%X",
    R8, R9, R10, R11, R12, R13, R14, R15)

  local f = io.open(outPath, "a")
  f:write(table.concat(out, "\n") .. "\n\n")
  f:close()

  captureCount = captureCount + 1
  if captureCount >= maxCaptures then
    debug_removeBreakpoint(target)
    local f2 = io.open(outPath, "a")
    f2:write("=== done: captured " .. maxCaptures .. " writes, breakpoint removed ===\n")
    f2:close()
  end
  return 1  -- continue execution, don't pop the debugger UI
end

debug_setBreakpoint(target, 4, bptWrite)
print("Breakpoint set on 0x" .. string.format("%X", target) .. " -- now MOVE your character.")

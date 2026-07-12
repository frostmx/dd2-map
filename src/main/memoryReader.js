// Minimal Win32 process-memory reader for an unprotected, single-player target
// process (DD2.exe). Uses koffi (prebuilt FFI, no native compiler needed) to
// call kernel32.dll directly: no kernel driver involved.

const koffi = require('koffi');

const kernel32 = koffi.load('kernel32.dll');

const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;
const TH32CS_SNAPPROCESS = 0x00000002;
const TH32CS_SNAPMODULE = 0x00000008;
const TH32CS_SNAPMODULE32 = 0x00000010;
const INVALID_HANDLE_VALUE = -1;
const MAX_PATH = 260;

// --- struct layouts (win32 PROCESSENTRY32 / MODULEENTRY32, ANSI) ---
const PROCESSENTRY32 = koffi.struct('PROCESSENTRY32', {
  dwSize: 'uint32',
  cntUsage: 'uint32',
  th32ProcessID: 'uint32',
  th32DefaultHeapID: 'uintptr_t',
  th32ModuleID: 'uint32',
  cntThreads: 'uint32',
  th32ParentProcessID: 'uint32',
  pcPriClassBase: 'int32',
  dwFlags: 'uint32',
  szExeFile: koffi.array('char', MAX_PATH),
});

const MODULEENTRY32 = koffi.struct('MODULEENTRY32', {
  dwSize: 'uint32',
  th32ModuleID: 'uint32',
  th32ProcessID: 'uint32',
  GlblcntUsage: 'uint32',
  ProccntUsage: 'uint32',
  modBaseAddr: 'uintptr_t',
  modBaseSize: 'uint32',
  hModule: 'uintptr_t',
  szModule: koffi.array('char', 256),
  szExePath: koffi.array('char', MAX_PATH),
});

const CreateToolhelp32Snapshot = kernel32.func('void *CreateToolhelp32Snapshot(uint32 dwFlags, uint32 th32ProcessID)');
const Process32First = kernel32.func('bool Process32First(void *hSnapshot, _Inout_ PROCESSENTRY32 *lppe)');
const Process32Next = kernel32.func('bool Process32Next(void *hSnapshot, _Inout_ PROCESSENTRY32 *lppe)');
const Module32First = kernel32.func('bool Module32First(void *hSnapshot, _Inout_ MODULEENTRY32 *lpme)');
const Module32Next = kernel32.func('bool Module32Next(void *hSnapshot, _Inout_ MODULEENTRY32 *lpme)');
const CloseHandle = kernel32.func('bool CloseHandle(void *hObject)');
const OpenProcess = kernel32.func('void *OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)');
const ReadProcessMemory = kernel32.func(
  'bool ReadProcessMemory(void *hProcess, uintptr_t lpBaseAddress, _Out_ uint8 *lpBuffer, size_t nSize, _Out_ size_t *lpNumberOfBytesRead)'
);
const GetLastError = kernel32.func('uint32 GetLastError()');

function findProcessIdByName(exeName) {
  const snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!snap || koffi.address(snap) === INVALID_HANDLE_VALUE) {
    throw new Error('CreateToolhelp32Snapshot(process) failed: ' + GetLastError());
  }
  try {
    const entry = { dwSize: koffi.sizeof(PROCESSENTRY32) };
    let ok = Process32First(snap, entry);
    while (ok) {
      const name = entry.szExeFile;
      if (name.toLowerCase() === exeName.toLowerCase()) {
        return entry.th32ProcessID;
      }
      entry.dwSize = koffi.sizeof(PROCESSENTRY32);
      ok = Process32Next(snap, entry);
    }
  } finally {
    CloseHandle(snap);
  }
  return null;
}

function findModuleBase(pid, moduleName) {
  const snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
  if (!snap || koffi.address(snap) === INVALID_HANDLE_VALUE) {
    throw new Error('CreateToolhelp32Snapshot(module) failed: ' + GetLastError());
  }
  try {
    const entry = { dwSize: koffi.sizeof(MODULEENTRY32) };
    let ok = Module32First(snap, entry);
    while (ok) {
      const name = entry.szModule;
      if (name.toLowerCase() === moduleName.toLowerCase()) {
        return { base: entry.modBaseAddr, size: entry.modBaseSize };
      }
      entry.dwSize = koffi.sizeof(MODULEENTRY32);
      ok = Module32Next(snap, entry);
    }
  } finally {
    CloseHandle(snap);
  }
  return null;
}

function openProcess(pid) {
  const handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
  if (!handle) {
    throw new Error(`OpenProcess(${pid}) failed: ${GetLastError()}`);
  }
  return handle;
}

function readMemory(handle, address, size) {
  const buffer = Buffer.alloc(size);
  const bytesRead = [0];
  const ok = ReadProcessMemory(handle, address, buffer, size, bytesRead);
  if (!ok) {
    throw new Error(`ReadProcessMemory at 0x${address.toString(16)} failed: ${GetLastError()}`);
  }
  return buffer;
}

function readPointer(handle, address) {
  const buf = readMemory(handle, address, 8);
  return buf.readBigUInt64LE(0);
}

// Resolves a Cheat Engine style pointer chain.
//   staticBase : absolute address of the static pointer (moduleBase + staticOffset)
//   offsets    : [O0, O1, ..., On] exactly as CE lists them (Offset 0 .. Offset n)
// Verified against DD2 (testChains.js): CE dereferences [base], then applies
// O0..O(n-1) each with a dereference, and adds On last without dereferencing.
function resolvePointerChain(handle, staticBase, offsets) {
  let p = readPointer(handle, staticBase);
  for (let i = 0; i < offsets.length - 1; i++) {
    p = readPointer(handle, p + BigInt(offsets[i]));
  }
  return p + BigInt(offsets[offsets.length - 1]);
}

function closeHandle(handle) {
  CloseHandle(handle);
}

module.exports = {
  findProcessIdByName,
  findModuleBase,
  openProcess,
  readMemory,
  readPointer,
  resolvePointerChain,
  closeHandle,
};

// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
)

// handleGPUStatus handles GET /api/gpu/status
// It calls rocm-smi and returns GPU device information.
func (s *Server) handleGPUStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	resp := GPUStatusResponse{}

	// Check if rocm-smi is available
	rocmSmi, err := exec.LookPath("rocm-smi")
	if err != nil {
		resp.Available = false
		writeJSON(w, http.StatusOK, resp)
		return
	}

	// Run: rocm-smi --showproductname --showmeminfo vram --showuse --showtemp --json
	cmd := exec.CommandContext(r.Context(), rocmSmi, "--showproductname", "--showmeminfo", "vram", "--showuse", "--showtemp", "--json")
	out, err := cmd.Output()
	if err != nil {
		resp.Available = false
		writeJSON(w, http.StatusOK, resp)
		return
	}

	// Parse the JSON output from rocm-smi
	devices := parseROCmSMIOutput(out)
	resp.Available = len(devices) > 0
	resp.Devices = devices

	// Get ROCm version
	verCmd := exec.CommandContext(r.Context(), rocmSmi, "--version")
	if verOut, err := verCmd.Output(); err == nil {
		resp.ROCmVersion = strings.TrimSpace(string(verOut))
	}

	writeJSON(w, http.StatusOK, resp)
}

// parseROCmSMIOutput parses the JSON output of rocm-smi.
// rocm-smi JSON structure varies by version; we do a best-effort parse.
func parseROCmSMIOutput(data []byte) []GPUDevice {
	// Try to parse as a map of GPU ID -> properties
	var raw map[string]map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}

	var devices []GPUDevice
	id := 0
	for key, props := range raw {
		if key == "system" {
			continue
		}
		dev := GPUDevice{ID: id}
		id++

		if name, ok := props["Card series"].(string); ok {
			dev.Name = name
		} else if name, ok := props["GPU"].(string); ok {
			dev.Name = name
		}

		if total, ok := props["VRAM Total Memory (B)"].(string); ok {
			dev.MemoryTotal = total
		} else if total, ok := props["vram_total"].(string); ok {
			dev.MemoryTotal = total
		}

		if used, ok := props["VRAM Total Used Memory (B)"].(string); ok {
			dev.MemoryUsed = used
		}

		if util, ok := props["GPU use (%)"].(string); ok {
			if v, err := strconv.Atoi(strings.TrimSuffix(util, "%")); err == nil {
				dev.Utilization = v
			}
		}

		if temp, ok := props["Temperature (Sensor junction) (C)"].(string); ok {
			if v, err := strconv.ParseFloat(temp, 64); err == nil {
				dev.Temperature = int(v)
			}
		}

		devices = append(devices, dev)
	}

	return devices
}

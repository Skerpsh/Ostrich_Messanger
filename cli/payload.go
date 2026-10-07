package main

import (
	"encoding/json"
	"strings"
)

// What a message carries inside its encryption, the same as the app's
// (frontend/src/lib/payload.ts): usually just its text; forwarded messages
// carry a small JSON object after a marker, so the server sees none of it.

const payloadMarker = "\u001eostrich1:"

type payload struct {
	text string
	// The username a forwarded message comes from.
	forwardedFrom string
}

type payloadWire struct {
	T string `json:"t"`
	F string `json:"f,omitempty"`
}

func encodePayload(p payload) string {
	if p.forwardedFrom == "" {
		return p.text
	}

	data, _ := json.Marshal(payloadWire{T: p.text, F: p.forwardedFrom})

	return payloadMarker + string(data)
}

// decodePayload: anything that is not a well-formed payload is text.
func decodePayload(plain string) payload {
	rest, ok := strings.CutPrefix(plain, payloadMarker)
	if !ok {
		return payload{text: plain}
	}

	var wire payloadWire

	if json.Unmarshal([]byte(rest), &wire) != nil {
		return payload{text: plain}
	}

	return payload{text: wire.T, forwardedFrom: wire.F}
}

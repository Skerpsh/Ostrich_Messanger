package main

import (
	"encoding/json"
	"regexp"
	"strings"
)

// What a message carries inside its encryption, the same as the app's
// (frontend/src/lib/payload.ts): usually just its text; forwarded messages
// and messages with files carry a small JSON object after a marker, so
// the server sees none of it.

const payloadMarker = "\u001eostrich1:"

// attachment is a file of a message, encrypted with its own key and
// uploaded under its id.
type attachment struct {
	ID  string
	Key string
	// Name and MIME type as the sender gave them: shown, never used as a
	// path without cleaning (see saveAttachment).
	Name string
	Mime string
	// Bytes, before encryption.
	Size int64
	// Pictures: their size in pixels.
	Width, Height int
}

type payload struct {
	text string
	// The username a forwarded message comes from.
	forwardedFrom string
	attachments   []attachment
}

type wireAttachment struct {
	I string `json:"i"`
	K string `json:"k"`
	N string `json:"n"`
	M string `json:"m"`
	S int64  `json:"s"`
	W int    `json:"w,omitempty"`
	H int    `json:"h,omitempty"`
}

type payloadWire struct {
	T string           `json:"t"`
	F string           `json:"f,omitempty"`
	A []wireAttachment `json:"a,omitempty"`
}

func encodePayload(p payload) string {
	if p.forwardedFrom == "" && len(p.attachments) == 0 {
		return p.text
	}

	wire := payloadWire{T: p.text, F: p.forwardedFrom}

	for _, a := range p.attachments {
		w := wireAttachment{I: a.ID, K: a.Key, N: a.Name, M: a.Mime, S: a.Size}

		if a.Width > 0 && a.Height > 0 {
			w.W, w.H = a.Width, a.Height
		}

		wire.A = append(wire.A, w)
	}

	data, _ := json.Marshal(wire)

	return payloadMarker + string(data)
}

var attachmentIDRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// decodePayload: anything that is not a well-formed payload is text;
// malformed attachments are left out.
func decodePayload(plain string) payload {
	rest, ok := strings.CutPrefix(plain, payloadMarker)
	if !ok {
		return payload{text: plain}
	}

	var wire struct {
		T *string           `json:"t"`
		F string            `json:"f"`
		A []json.RawMessage `json:"a"`
	}

	if json.Unmarshal([]byte(rest), &wire) != nil || wire.T == nil {
		return payload{text: plain}
	}

	p := payload{text: *wire.T, forwardedFrom: wire.F}

	for _, raw := range wire.A {
		var a wireAttachment

		if json.Unmarshal(raw, &a) != nil || !attachmentIDRE.MatchString(a.I) || a.K == "" {
			continue
		}

		p.attachments = append(p.attachments, attachment{
			ID: a.I, Key: a.K, Name: a.N, Mime: a.M, Size: a.S, Width: a.W, Height: a.H,
		})
	}

	return p
}

package main

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestMarkup(t *testing.T) {
	cases := []struct {
		text string
		want []span
	}{
		{"a **b** c", []span{{"a ", spanStyle{}}, {"b", spanStyle{bold: true}}, {" c", spanStyle{}}}},
		{"_it_ and *it* ~~s~~ `x * y`", []span{
			{"it", spanStyle{italic: true}}, {" and ", spanStyle{}}, {"it", spanStyle{italic: true}},
			{" ", spanStyle{}}, {"s", spanStyle{strike: true}}, {" ", spanStyle{}}, {"x * y", spanStyle{code: true}},
		}},
		{"**bold _both_**", []span{{"bold ", spanStyle{bold: true}}, {"both", spanStyle{bold: true, italic: true}}}},
		{"```\nconst a = 1;\n```", []span{{"const a = 1;", spanStyle{code: true}}}},
		{"see https://example.com/a?b=1.", []span{
			{"see ", spanStyle{}}, {"https://example.com/a?b=1", spanStyle{link: "https://example.com/a?b=1"}}, {".", spanStyle{}},
		}},
		{"(https://x.org)", []span{{"(", spanStyle{}}, {"https://x.org", spanStyle{link: "https://x.org"}}, {")", spanStyle{}}}},
	}

	for _, c := range cases {
		if got := parseMarkup(c.text); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q:\n got %+v\nwant %+v", c.text, got, c.want)
		}
	}

	// No formatting where it is not meant.
	for _, text := range []string{"snake_case_name", "2 * 3 * 4", "** not bold **", "a_b", "*", "**"} {
		if got := plainText(text); got != text {
			t.Errorf("%q became %q", text, got)
		}
	}
}

func TestPayload(t *testing.T) {
	if encodePayload(payload{text: "hi"}) != "hi" {
		t.Fatal("plain text changed")
	}

	got := decodePayload(encodePayload(payload{text: "hi", forwardedFrom: "alice"}))

	if got.text != "hi" || got.forwardedFrom != "alice" || got.attachments != nil {
		t.Fatalf("forward: %+v", got)
	}

	// The same bytes as the app's.
	if got := decodePayload("\u001eostrich1:{\"t\":\"x\",\"f\":\"bob\"}"); got.text != "x" || got.forwardedFrom != "bob" {
		t.Fatalf("app payload not read: %+v", got)
	}

	if broken := "\u001eostrich1:{oops"; decodePayload(broken).text != broken {
		t.Fatal("broken payload not shown as text")
	}

	// Malformed attachments are left out.
	if got := decodePayload(payloadMarker + `{"t":"x","a":[{"i":"nope"},{"i":1}]}`); got.text != "x" || len(got.attachments) != 0 {
		t.Fatalf("malformed attachments: %+v", got)
	}
}

// The same cases as the app's (frontend/src/lib/markup.test.ts).
func TestMentions(t *testing.T) {
	data, err := os.ReadFile("../testdata/markup-mentions.json")
	if err != nil {
		t.Fatal(err)
	}

	var cases struct {
		Mentions [][2]json.RawMessage `json:"mentions"`
	}

	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}

	for _, c := range cases.Mentions {
		var text string
		var want []string

		_ = json.Unmarshal(c[0], &text)
		_ = json.Unmarshal(c[1], &want)

		got := []string{}

		for _, s := range parseMarkup(text) {
			if s.style.mention != "" && !s.style.code {
				got = append(got, s.style.mention)
			}
		}

		if !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %v, want %v", text, got, want)
		}
	}
}

package main

import (
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

	if got != (payload{text: "hi", forwardedFrom: "alice"}) {
		t.Fatalf("forward: %+v", got)
	}

	// The same bytes as the app's.
	if decodePayload("\u001eostrich1:{\"t\":\"x\",\"f\":\"bob\"}") != (payload{text: "x", forwardedFrom: "bob"}) {
		t.Fatal("app payload not read")
	}

	if broken := "\u001eostrich1:{oops"; decodePayload(broken).text != broken {
		t.Fatal("broken payload not shown as text")
	}
}

package main

import (
	"errors"
	"net/http"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// Messages on their way, like the app's outbox: shown in the chat at once
// with a clock, sent in the background, and kept and sent again while
// there is no network. The client chooses each message's id, so sending
// one twice is harmless (the server answers 409 for the second).

const outboxRetry = 15 * time.Second

type outgoing struct {
	message Message
	// Ids of its encrypted files, already uploaded.
	attachments []string
	// "sending" (in flight or waiting for the network) or "failed".
	state    string
	err      string
	inFlight bool
}

// queueMessage adds an encrypted message to the outbox and sends it.
func (m *model) queueMessage(chatID, id, content string, replyTo *ReplyPreview, attachments []string) tea.Cmd {
	m.outgoing = append(m.outgoing, outgoing{
		attachments: attachments,
		message: Message{
			ID:             id,
			ChatID:         chatID,
			SenderID:       m.user.User.ID,
			SenderUsername: m.user.User.Username,
			Content:        content,
			CreatedAt:      time.Now().UTC().Format(time.RFC3339Nano),
			ReplyTo:        replyTo,
		},
		state: "sending",
	})

	return m.attemptSend(id)
}

func (m *model) findOutgoing(id string) int {
	for i, o := range m.outgoing {
		if o.message.ID == id {
			return i
		}
	}

	return -1
}

func (m *model) dropOutgoing(id string) {
	if i := m.findOutgoing(id); i >= 0 {
		m.outgoing = append(m.outgoing[:i], m.outgoing[i+1:]...)
	}
}

func (m *model) attemptSend(id string) tea.Cmd {
	i := m.findOutgoing(id)

	if i < 0 || m.outgoing[i].inFlight || m.user == nil {
		return nil
	}

	m.outgoing[i].inFlight = true
	m.outgoing[i].state = "sending"
	m.outgoing[i].err = ""
	o := m.outgoing[i].message
	files := m.outgoing[i].attachments
	token := m.user.Token

	replyID := ""

	if o.ReplyTo != nil {
		replyID = o.ReplyTo.ID
	}

	return task(func() func(*model) tea.Cmd {
		sent, err := sendMessage(token, o.ChatID, o.ID, o.Content, replyID, files)

		return func(m *model) tea.Cmd {
			i := m.findOutgoing(id)

			if i < 0 || m.user == nil || m.user.Token != token {
				return nil
			}

			m.outgoing[i].inFlight = false

			var apiErr *apiError

			switch {
			case err == nil:
				m.dropOutgoing(id)

				if m.chat != nil && m.chat.id == sent.ChatID {
					m.chat.mergeMessages([]Message{sent})
				}
			case errors.Is(err, errSessionExpired):
				return m.fail(err)
			case errors.As(err, &apiErr) && apiErr.status == http.StatusConflict:
				// Sent before; the answer got lost. The history has it.
				m.dropOutgoing(id)
			case errors.As(err, &apiErr):
				m.outgoing[i].state = "failed"
				m.outgoing[i].err = apiErr.message
			default:
				// No network: stays queued.
			}

			return nil
		}
	})
}

// flushOutbox sends again what is waiting (back online, and now and
// then).
func (m *model) flushOutbox() tea.Cmd {
	var cmds []tea.Cmd

	for _, o := range m.outgoing {
		if o.state == "sending" && !o.inFlight {
			cmds = append(cmds, m.attemptSend(o.message.ID))
		}
	}

	return tea.Batch(cmds...)
}

type outboxTickMsg struct{}

func outboxTick() tea.Cmd {
	return tea.Tick(outboxRetry, func(time.Time) tea.Msg { return outboxTickMsg{} })
}

// outgoingState: "sending" / "failed" for a message on its way, "" for
// one the server has.
func (m model) outgoingState(id string) string {
	for _, o := range m.outgoing {
		if o.message.ID == id {
			return o.state
		}
	}

	return ""
}

// shown is the open chat's history with the own messages still on their
// way.
func (m model) shown() []Message {
	c := m.chat
	var pending []Message

	for _, o := range m.outgoing {
		if o.message.ChatID == c.id && c.indexOf(o.message.ID) < 0 {
			pending = append(pending, o.message)
		}
	}

	if len(pending) == 0 {
		return c.messages
	}

	all := append(append([]Message{}, c.messages...), pending...)
	sortMessages(all)

	return all
}

func (m model) shownIndex(id string) int {
	for i, message := range m.shown() {
		if message.ID == id {
			return i
		}
	}

	return -1
}

// shownMessage is a decrypted message as the chat shows it.
type shownMessage struct {
	text          string
	status        decryptStatus
	forwardedFrom string
	attachments   []attachment
}

// show decrypts a message and reads its payload (text, forward); text
// that was not encrypted is shown as it is.
func (m model) show(chat Chat, messageID, senderID, content string) shownMessage {
	text, status := m.decrypt(chat, messageID, senderID, content)

	if status != decryptOK {
		return shownMessage{text: text, status: status}
	}

	p := decodePayload(text)

	return shownMessage{text: p.text, status: status, forwardedFrom: p.forwardedFrom, attachments: p.attachments}
}

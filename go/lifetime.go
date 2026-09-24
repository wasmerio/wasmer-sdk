package wasmer

import (
	"errors"
	"sync"
)

// A scope prevents new calls during close, interrupts work before draining it,
// and keeps all native ancestors alive until their children are destroyed.
type scope struct {
	mu       sync.Mutex
	parent   *scope
	children map[*scope]struct{}
	closing  bool
	done     chan struct{}
	active   sync.WaitGroup
	shutdown func() error
	destroy  func()
	err      error
}

func newScope(parent *scope, shutdown func() error, destroy func()) *scope {
	s := &scope{parent: parent, children: make(map[*scope]struct{}), done: make(chan struct{}), shutdown: shutdown, destroy: destroy}
	if parent != nil {
		// Creation runs under a parent call guard, so close drains newly created
		// children after waiting for that call to return as well.
		parent.mu.Lock()
		parent.children[s] = struct{}{}
		parent.mu.Unlock()
	}
	return s
}

func (s *scope) enter() (func(), error) {
	if s == nil {
		return nil, ErrClosed
	}
	parentDone := func() {}
	if s.parent != nil {
		var err error
		parentDone, err = s.parent.enter()
		if err != nil {
			return nil, err
		}
	}
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		parentDone()
		return nil, ErrClosed
	}
	s.active.Add(1)
	s.mu.Unlock()
	return func() { s.active.Done(); parentDone() }, nil
}

func (s *scope) close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		<-s.done
		return s.err
	}
	s.closing = true
	s.mu.Unlock()
	if s.shutdown != nil {
		s.err = nativeError(s.shutdown())
	}
	drain := func() {
		s.mu.Lock()
		children := make([]*scope, 0, len(s.children))
		for child := range s.children {
			children = append(children, child)
		}
		s.mu.Unlock()
		for _, child := range children {
			s.err = errors.Join(s.err, child.close())
		}
	}
	drain()
	s.active.Wait()
	drain()
	if s.destroy != nil {
		s.destroy()
	}
	if s.parent != nil {
		s.parent.mu.Lock()
		delete(s.parent.children, s)
		s.parent.mu.Unlock()
	}
	close(s.done)
	return s.err
}

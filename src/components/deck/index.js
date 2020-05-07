import React from 'react';
import PropTypes from 'prop-types';
import styled, { ThemeContext, ThemeProvider } from 'styled-components';
import normalize from 'normalize-newline';
import indentNormalizer from '../../utils/indent-normalizer';
import useDeck, { DeckContext } from '../../hooks/use-deck';
import isComponentType from '../../utils/is-component-type';
import visitDeckElements from '../../utils/visit-deck-elements';
import useUrlRouting from '../../hooks/use-url-routing';
import PresenterDeck from './presenter-deck';
import AudienceDeck from './audience-deck';
import { mergeTheme } from '../../theme';
import { PrintDeck } from './print-deck';
import { animated, useTransition } from 'react-spring';
import {
  TransitionPipeContext,
  TransitionPipeProvider
} from '../../hooks/use-transition-pipe';
import usePresentation, {
  MSG_SLIDE_STATE_CHANGE
} from '../../hooks/use-presentation';
import useKeyboardControls from '../../hooks/use-keyboard-controls';
import useTouchControls from '../../hooks/use-touch-controls';
import {
  DEFAULT_SLIDE_ELEMENT_INDEX,
  DEFAULT_SLIDE_INDEX
} from '../../utils/constants';
import searchChildrenForAppear from '../../utils/search-children-appear';
import searchChildrenForStepper from '../../utils/search-children-stepper';
import OverviewDeck from './overview-deck';
import { Markdown, Slide, Notes } from '../../index';
import { isolateNotes, removeNotes } from '../../utils/notes';

const AnimatedDeckDiv = styled(animated.div)`
  height: 100vh;
  width: 100vw;
  position: fixed;
`;
AnimatedDeckDiv.displayName = 'AnimatedDeckDiv';

const defaultTransition = {
  slide: {
    from: {
      position: 'fixed',
      transform: 'translate(100%, 0%)'
    },
    enter: {
      position: 'fixed',
      transform: 'translate(0, 0%)'
    },
    leave: {
      position: 'fixed',
      transform: 'translate(-100%, 0%)'
    },
    config: { precision: 0 }
  },
  fade: {
    enter: { opacity: 1 },
    from: { opacity: 0 },
    leave: { opacity: 0 },
    config: { precision: 0 }
  },
  none: {
    enter: {},
    from: {},
    leave: {},
    config: { precision: 0 }
  }
};

const builtInTransitions = Object.keys(defaultTransition);

/**
 * Provides top level state/context provider with useDeck hook
 * Should wrap all the presentation components (slides, etc)
 *
 * Props = {
 *  loop: bool (pass in true if you want slides to loop)
 * transitionEffect: based off of react sprint useTransition
 * }
 *
  Not: Immediate is a React-Spring property that we pass to the animations
 * essentially it skips animations.
 */

const initialState = {
  currentSlide: DEFAULT_SLIDE_INDEX,
  immediate: false,
  immediateElement: false,
  currentSlideElement: DEFAULT_SLIDE_ELEMENT_INDEX,
  reverseDirection: false,
  presenterMode: false,
  overviewMode: false,
  notes: {},
  resolvedInitialUrl: false
};

const Deck = props => {
  const {
    children,
    loop,
    keyboardControls,
    animationsWhenGoingBack,
    backgroundColor,
    textColor,
    template,
    transitionEffect
  } = props;

  // TODO: React.useMemo this somehow so we're not doing the traversal if we
  // don't absolutely need to

  let currentSlide = null;
  let slideIndex = -1;
  const slideElementMap = {};
  const slides = [];
  visitDeckElements(children, {
    enterSlide: slide => {
      if (currentSlide) {
        throw new Error('<Slide> elements should not be nested.');
      } else {
        slides.push(slide);
        slideIndex += 1;
        currentSlide = slide;
        slideElementMap[slideIndex] = 0;
      }
    },
    exitSlide: () => {
      currentSlide = null;
    },
    visitAppear: () => {
      // TODO: validate that we're inside a <Slide>
      // TODO: other stuff is happening in search-children-appear
      slideElementMap[slideIndex] += 1;
    },
    visitStepper: () => {
      // TODO: validate that we're inside a <Slide>
      // TODO: other stuff is happening in search-children-stepper
      slideElementMap[slideIndex] += 1;
    }
    // TODO: console warnings if we're not in a <Slide>
    // visitUnrecognized: () => {},
    // TODO: console warnings if we're not in a <Slide>
    // visitMarkdownNotSlides: () => {},
  });

  console.log(slideElementMap);

  const numberOfSlides = slides.length;

  if (numberOfSlides === 0) {
    throw new Error('Spectacle must have at least one slide to run.');
  }

  // Initialise useDeck hook and get state and dispatch off of it
  const { state, dispatch } = useDeck({ ...initialState, numberOfSlides });
  const themeContext = React.useContext(ThemeContext);

  React.useLayoutEffect(() => {
    document.body.style.margin = '0';
    document.body.style.background = '#000';
    document.body.style.color =
      themeContext.colors[textColor] ||
      textColor ||
      themeContext.colors.primary;
  }, [backgroundColor, textColor, themeContext.colors]);

  const {
    startConnection,
    terminateConnection,
    sendMessage,
    errors,
    addMessageHandler,
    isReceiver,
    isController
  } = usePresentation();

  const onUrlChange = React.useCallback(
    update => {
      if (isController) {
        sendMessage({
          type: MSG_SLIDE_STATE_CHANGE,
          payload: update
        });
      }
    },
    [sendMessage, isController]
  );

  const {
    navigateToNext,
    navigateToPrevious,
    navigateTo,
    toggleMode,
    goToSlide
  } = useUrlRouting({
    dispatch,
    currentSlide: state.currentSlide,
    currentSlideElement: state.currentSlideElement,
    currentPresenterMode: state.presenterMode,
    slideElementMap,
    loop,
    animationsWhenGoingBack,
    onUrlChange
  });

  useKeyboardControls({
    keyboardControls,
    navigateToNext,
    navigateToPrevious,
    toggleMode
  });

  useTouchControls({
    navigateToNext,
    navigateToPrevious
  });

  const { runTransition } = React.useContext(TransitionPipeContext);
  const slideTransitionEffect =
    slides[state.currentSlide].props.transitionEffect || {};
  const transitionRef = React.useRef(null);
  const broadcastChannelRef = React.useRef(null);

  React.useEffect(() => {
    if (typeof MessageChannel !== 'undefined') {
      broadcastChannelRef.current = new BroadcastChannel(
        'spectacle_presenter_mode_channel'
      );
    }
    return () => {
      if (!broadcastChannelRef.current) {
        return;
      }
      broadcastChannelRef.current.close();
    };
  }, []);

  React.useEffect(() => {
    if (
      broadcastChannelRef.current &&
      typeof broadcastChannelRef.current.postMessage === 'function'
    ) {
      broadcastChannelRef.current.onmessage = message => {
        if (state.presenterMode) {
          return;
        }
        const { slide, element } = JSON.parse(message.data);
        navigateTo({ slideIndex: slide, elementIndex: element });
      };
      if (state.presenterMode) {
        const slideData = {
          slide: state.currentSlide,
          element: state.currentSlideElement
        };
        broadcastChannelRef.current.postMessage(JSON.stringify(slideData));
      }
    }
  }, [
    state.currentSlide,
    state.currentSlideElement,
    state.presenterMode,
    navigateTo
  ]);

  React.useEffect(() => {
    if (!transitionRef.current) {
      return;
    }
    runTransition(transitionRef.current);
  }, [transitionRef, state.currentSlide, runTransition]);

  let currentTransition = {};

  if (
    typeof slideTransitionEffect === 'string' &&
    builtInTransitions.includes(slideTransitionEffect)
  ) {
    currentTransition = defaultTransition[slideTransitionEffect];
  } else if (
    typeof slideTransitionEffect === 'object' &&
    Object.keys(slideTransitionEffect).length !== 0
  ) {
    currentTransition = slideTransitionEffect;
  } else if (
    typeof transitionEffect === 'string' &&
    builtInTransitions.includes(transitionEffect)
  ) {
    currentTransition = defaultTransition[transitionEffect];
  } else if (
    typeof transitionEffect === 'object' &&
    Object.keys(transitionEffect).length !== 0
  ) {
    currentTransition = transitionEffect;
  } else {
    currentTransition = defaultTransition['slide'];
  }

  const transitions = useTransition(state.currentSlide, p => p, {
    ref: transitionRef,
    enter: currentTransition.enter,
    leave: currentTransition.leave,
    from: currentTransition.from,
    unique: true,
    immediate: state.immediate
  });

  let content = null;
  if (state.resolvedInitialUrl) {
    if (state.overviewMode) {
      const staticSlides = slides.map((slide, index) =>
        React.cloneElement(slide, {
          slideNum: index,
          template
        })
      );
      content = (
        <OverviewDeck goToSlide={goToSlide}>{staticSlides}</OverviewDeck>
      );
    } else if (state.exportMode) {
      const staticSlides = slides.map((slide, index) =>
        React.cloneElement(slide, {
          slideNum: index,
          template: template
        })
      );
      content = <PrintDeck>{staticSlides}</PrintDeck>;
    } else if (state.presenterMode) {
      const staticSlides = slides.map((slide, index) =>
        React.cloneElement(slide, {
          slideNum: index,
          template
        })
      );
      content = (
        <PresenterDeck
          isController={isController}
          isReceiver={isReceiver}
          startConnection={startConnection}
          terminateConnection={terminateConnection}
        >
          {staticSlides}
        </PresenterDeck>
      );
    } else {
      const animatedSlides = transitions.map(
        ({ item, props: animatedStyleProps, key }) => (
          <AnimatedDeckDiv style={animatedStyleProps} key={key}>
            {React.cloneElement(slides[item], {
              slideNum: item,
              numberOfSlides,
              template
            })}
          </AnimatedDeckDiv>
        )
      );

      content = (
        <AudienceDeck addMessageHandler={addMessageHandler}>
          {animatedSlides}
        </AudienceDeck>
      );
    }
  }

  return (
    <>
      <DeckContext.Provider
        value={{
          state,
          dispatch,
          numberOfSlides,
          keyboardControls,
          animationsWhenGoingBack,
          slideElementMap,
          goToSlide
        }}
      >
        {content}
      </DeckContext.Provider>
    </>
  );
};

Deck.propTypes = {
  animationsWhenGoingBack: PropTypes.bool.isRequired,
  backgroundColor: PropTypes.string,
  children: PropTypes.node.isRequired,
  keyboardControls: PropTypes.oneOf(['arrows', 'space']),
  loop: PropTypes.bool.isRequired,
  template: PropTypes.func,
  textColor: PropTypes.string,
  theme: PropTypes.object,
  transitionEffect: PropTypes.oneOfType([
    PropTypes.shape({
      from: PropTypes.object,
      enter: PropTypes.object,
      leave: PropTypes.object
    }),
    PropTypes.oneOf(['fade', 'slide', 'none'])
  ])
};

const ConnectedDeck = props => (
  <ThemeProvider theme={mergeTheme(props.theme)}>
    <TransitionPipeProvider>
      <Deck {...props} />
    </TransitionPipeProvider>
  </ThemeProvider>
);

ConnectedDeck.propTypes = Deck.propTypes;
ConnectedDeck.defaultProps = {
  loop: false,
  keyboardControls: 'arrows',
  animationsWhenGoingBack: false
};

export default ConnectedDeck;

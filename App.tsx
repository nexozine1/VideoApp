import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  StyleSheet, 
  View, 
  Text, 
  TouchableOpacity, 
  FlatList, 
  Dimensions, 
  StatusBar, 
  Alert,
  ActivityIndicator,
  TouchableWithoutFeedback
} from 'react-native';
import { Video, ResizeMode, AVPlaybackStatus } from 'expo-av';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons'; // Built-in to Expo

// --- CONFIGURATION ---
const STEPS_STORAGE_KEY = 'APP_VIDEO_STEPS_V1';
const { width, height } = Dimensions.get('window');

// --- TYPES ---
interface VideoStep {
  id: string;
  stepNumber: number;
  uri: string;
  filename: string;
}

// --- THEME ---
const THEME = {
  background: '#000000',
  surface: '#121212',
  primary: '#0A84FF', // iOS Blue
  text: '#FFFFFF',
  textDim: '#888888',
  danger: '#FF453A',
};

// --- COMPONENT: DOUBLE BUFFERED PLAYER ---
// This is the magic component that ensures zero-gap playback
const SeamlessPlayer = ({ 
  playlist, 
  onExit 
}: { 
  playlist: VideoStep[], 
  onExit: () => void 
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);

  // We use two refs for our two players
  const playerARef = useRef<Video>(null);
  const playerBRef = useRef<Video>(null);

  // 0 = Player A is active, 1 = Player B is active
  const [activePlayerId, setActivePlayerId] = useState<0 | 1>(0);

  // PRELOAD LOGIC
  useEffect(() => {
    loadInitialVideos();
  }, []);

  const loadInitialVideos = async () => {
    // Fake progress for UX feel, then real loading
    let progress = 0;
    const interval = setInterval(() => {
      progress += 10;
      if (progress > 80) clearInterval(interval);
      setLoadingProgress(progress);
    }, 200);

    // Ensure first video is ready in Player A
    if (playerARef.current && playlist[0]) {
      await playerARef.current.loadAsync({ uri: playlist[0].uri }, { shouldPlay: false });
    }
    
    // Ensure second video is ready in Player B (if exists)
    if (playerBRef.current && playlist[1]) {
      await playerBRef.current.loadAsync({ uri: playlist[1].uri }, { shouldPlay: false });
    }

    clearInterval(interval);
    setLoadingProgress(100);
    setTimeout(() => setIsReady(true), 500); // Small delay for smoothness
  };

  const handleTap = async () => {
    const nextIndex = currentIndex + 1;
    
    // If we are at the end, maybe exit or loop? Let's exit for now.
    if (nextIndex >= playlist.length) {
      onExit();
      return;
    }

    // SWAP PLAYERS
    const nextActiveId = activePlayerId === 0 ? 1 : 0;
    const nextPlayerRef = nextActiveId === 0 ? playerARef : playerBRef;
    const prevPlayerRef = nextActiveId === 0 ? playerBRef : playerARef;

    // 1. Instant Play on the next player (already loaded)
    await nextPlayerRef.current?.playAsync();

    // 2. Switch UI State to show the new player
    setActivePlayerId(nextActiveId);
    setCurrentIndex(nextIndex);

    // 3. Cleanup previous player and Preload the one after next
    await prevPlayerRef.current?.stopAsync();
    
    const futureIndex = nextIndex + 1;
    if (futureIndex < playlist.length) {
      // Load the video *after* the next one into the now-hidden player
      await prevPlayerRef.current?.loadAsync(
        { uri: playlist[futureIndex].uri }, 
        { shouldPlay: false } // Preload but don't play
      );
    } else {
      await prevPlayerRef.current?.unloadAsync();
    }
  };

  if (!isReady) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={THEME.primary} />
        <Text style={styles.loadingText}>Preparing Studio...</Text>
        <View style={styles.progressBarBg}>
          <View style={[styles.progressBarFill, { width: `${loadingProgress}%` }]} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.fullscreenContainer}>
      <ExpoStatusBar hidden />
      
      {/* PLAYER A */}
      <View style={[styles.videoLayer, { opacity: activePlayerId === 0 ? 1 : 0, zIndex: activePlayerId === 0 ? 2 : 1 }]}>
        <Video
          ref={playerARef}
          style={styles.video}
          resizeMode={ResizeMode.COVER}
          isLooping={true} // Loop current step until tap
          shouldPlay={activePlayerId === 0}
        />
      </View>

      {/* PLAYER B */}
      <View style={[styles.videoLayer, { opacity: activePlayerId === 1 ? 1 : 0, zIndex: activePlayerId === 1 ? 2 : 1 }]}>
        <Video
          ref={playerBRef}
          style={styles.video}
          resizeMode={ResizeMode.COVER}
          isLooping={true}
          shouldPlay={activePlayerId === 1}
        />
      </View>

      {/* INVISIBLE TOUCH LAYER */}
      <TouchableWithoutFeedback onPress={handleTap}>
        <View style={styles.touchLayer} />
      </TouchableWithoutFeedback>
    </View>
  );
};

// --- COMPONENT: MANAGER SCREEN ---
export default function App() {
  const [steps, setSteps] = useState<VideoStep[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    loadSteps();
  }, []);

  const loadSteps = async () => {
    try {
      const saved = await AsyncStorage.getItem(STEPS_STORAGE_KEY);
      if (saved) setSteps(JSON.parse(saved));
    } catch (e) {
      console.error("Failed to load steps");
    }
  };

  const saveSteps = async (newSteps: VideoStep[]) => {
    setSteps(newSteps);
    await AsyncStorage.setItem(STEPS_STORAGE_KEY, JSON.stringify(newSteps));
  };

  const pickVideo = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      allowsEditing: false, // Editing often recompresses and creates delays
      quality: 1,
    });

    if (!result.canceled) {
      const asset = result.assets[0];
      const newStepNum = steps.length + 1;
      
      // Move file to permanent storage so it persists
      const fileName = `video_step_${newStepNum}_${Date.now()}.mov`;
      const newPath = FileSystem.documentDirectory + fileName;
      
      try {
        await FileSystem.copyAsync({
          from: asset.uri,
          to: newPath
        });

        const newStep: VideoStep = {
          id: Date.now().toString(),
          stepNumber: newStepNum,
          uri: newPath,
          filename: fileName
        };

        await saveSteps([...steps, newStep]);
      } catch (e) {
        Alert.alert("Error", "Could not save video locally.");
      }
    }
  };

  const clearAll = async () => {
    Alert.alert("Reset", "Delete all videos?", [
      { text: "Cancel", style: "cancel" },
      { 
        text: "Delete", 
        style: "destructive", 
        onPress: async () => {
          await saveSteps([]); 
          // Optional: Clean up file system here
        }
      }
    ]);
  };

  if (isPlaying) {
    return <SeamlessPlayer playlist={steps} onExit={() => setIsPlaying(false)} />;
  }

  return (
    <View style={styles.container}>
      <ExpoStatusBar style="light" />
      
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Studio Manager</Text>
        <TouchableOpacity onPress={clearAll}>
          <Text style={styles.resetText}>Reset</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={steps}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No videos uploaded yet.</Text>
            <Text style={styles.emptySubText}>Upload Step 1 to get started.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.stepCard}>
            <View style={styles.stepIcon}>
              <Ionicons name="videocam" size={24} color={THEME.text} />
            </View>
            <View style={styles.stepInfo}>
              <Text style={styles.stepTitle}>Step {item.stepNumber}</Text>
              <Text style={styles.stepSubtitle}>Ready for playback</Text>
            </View>
            <Ionicons name="checkmark-circle" size={24} color={THEME.primary} />
          </View>
        )}
      />

      <View style={styles.footer}>
        <TouchableOpacity style={styles.uploadButton} onPress={pickVideo}>
          <Ionicons name="add" size={24} color="white" />
          <Text style={styles.buttonText}>
            Upload Step {steps.length + 1}
          </Text>
        </TouchableOpacity>

        {steps.length > 0 && (
          <TouchableOpacity 
            style={styles.playButton} 
            onPress={() => setIsPlaying(true)}
          >
            <Ionicons name="play" size={24} color="white" />
            <Text style={styles.buttonText}>Start Experience</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.background,
    paddingTop: 60,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    marginBottom: 20,
  },
  headerTitle: {
    color: THEME.text,
    fontSize: 28,
    fontWeight: '700',
  },
  resetText: {
    color: THEME.danger,
    fontSize: 16,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 150,
  },
  stepCard: {
    backgroundColor: THEME.surface,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  stepIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#333',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 15,
  },
  stepInfo: {
    flex: 1,
  },
  stepTitle: {
    color: THEME.text,
    fontSize: 18,
    fontWeight: '600',
  },
  stepSubtitle: {
    color: THEME.textDim,
    fontSize: 14,
  },
  emptyState: {
    alignItems: 'center',
    marginTop: 100,
  },
  emptyText: {
    color: THEME.textDim,
    fontSize: 18,
    marginBottom: 8,
  },
  emptySubText: {
    color: '#444',
    fontSize: 14,
  },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.9)',
    padding: 20,
    paddingBottom: 40,
    borderTopWidth: 1,
    borderTopColor: '#222',
  },
  uploadButton: {
    backgroundColor: '#333',
    borderRadius: 14,
    height: 56,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  playButton: {
    backgroundColor: THEME.primary,
    borderRadius: 14,
    height: 56,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: THEME.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  buttonText: {
    color: 'white',
    fontSize: 17,
    fontWeight: '600',
    marginLeft: 8,
  },
  // PLAYER STYLES
  fullscreenContainer: {
    flex: 1,
    backgroundColor: 'black',
  },
  videoLayer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'black',
  },
  video: {
    width: width,
    height: height,
  },
  touchLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 999,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: 'black',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: THEME.text,
    marginTop: 20,
    marginBottom: 20,
    fontSize: 16,
    letterSpacing: 1,
  },
  progressBarBg: {
    width: 200,
    height: 4,
    backgroundColor: '#333',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: THEME.primary,
  }
});